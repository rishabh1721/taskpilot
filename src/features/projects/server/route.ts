import { z } from "zod";
import { Hono } from "hono";
import { ID, Query } from "node-appwrite";
import { zValidator } from "@hono/zod-validator";
import { endOfMonth, startOfMonth, subMonths } from "date-fns";

import { TaskStatus } from "@/features/tasks/types";
import { getMember } from "@/features/members/utils";

import { DATABASE_ID, IMAGES_BUCKET_ID, PROJECTS_ID, TASKS_ID } from "@/config";
import { sessionMiddleware } from "@/lib/session-middleware";

import { createProjectSchema, updateProjectSchema } from "../schemas";

import { Project } from "../types";

// --- Helper Functions ---

// Extracts the Appwrite File ID from the View URL so we can delete it later
const extractFileIdFromUrl = (url?: string | null) => {
  if (!url) return null;
  const match = url.match(/\/files\/([a-zA-Z0-9_-]+)\/view/);
  return match ? match[1] : null;
};

// --- Router ---

const app = new Hono()
  .post(
    "/",
    sessionMiddleware,
    zValidator("form", createProjectSchema),
    async (c) => {
      const databases = c.get("databases");
      const storage = c.get("storage");
      const user = c.get("user");

      const { name, image, workspaceId } = c.req.valid("form");

      const member = await getMember({
        databases,
        workspaceId,
        userId: user.$id,
      });

      if (!member) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      let uploadedImageUrl: string | undefined;

      if (image instanceof File) {
        const file = await storage.createFile(
          IMAGES_BUCKET_ID,
          ID.unique(),
          image,
        );

        uploadedImageUrl = `${process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT}/storage/buckets/${IMAGES_BUCKET_ID}/files/${file.$id}/view?project=${process.env.NEXT_PUBLIC_APPWRITE_PROJECT}`;
      }

      const project = await databases.createDocument(
        DATABASE_ID,
        PROJECTS_ID,
        ID.unique(),
        {
          name,
          imageUrl: uploadedImageUrl,
          workspaceId,
        },
      );

      return c.json({ data: project });
    },
  )
  .get(
    "/",
    sessionMiddleware,
    zValidator("query", z.object({ workspaceId: z.string() })),
    async (c) => {
      const user = c.get("user");
      const databases = c.get("databases");

      const { workspaceId } = c.req.valid("query");

      if (!workspaceId) {
        return c.json({ error: "Missing workspaceId" }, 400);
      }

      const member = await getMember({
        databases,
        workspaceId,
        userId: user.$id,
      });

      if (!member) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const projects = await databases.listDocuments<Project>(
        DATABASE_ID,
        PROJECTS_ID,
        [
          Query.equal("workspaceId", workspaceId),
          Query.orderDesc("$createdAt"),
        ],
      );

      return c.json({ data: projects });
    },
  )
  .get("/:projectId", sessionMiddleware, async (c) => {
    const user = c.get("user");
    const databases = c.get("databases");
    const { projectId } = c.req.param();

    const project = await databases.getDocument<Project>(
      DATABASE_ID,
      PROJECTS_ID,
      projectId,
    );

    const member = await getMember({
      databases,
      workspaceId: project.workspaceId,
      userId: user.$id,
    });

    if (!member) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    return c.json({ data: project });
  })
  .patch(
    "/:projectId",
    sessionMiddleware,
    zValidator("form", updateProjectSchema),
    async (c) => {
      const databases = c.get("databases");
      const storage = c.get("storage");
      const user = c.get("user");

      const { projectId } = c.req.param();
      const { name, image } = c.req.valid("form");

      const existingProject = await databases.getDocument<Project>(
        DATABASE_ID,
        PROJECTS_ID,
        projectId,
      );

      const member = await getMember({
        databases,
        workspaceId: existingProject.workspaceId,
        userId: user.$id,
      });

      if (!member) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      let uploadedImageUrl: string | undefined;

      if (image instanceof File) {
        // Optional: If you want to clean up old images on update
        // const oldImageId = extractFileIdFromUrl(existingProject.imageUrl);
        // if (oldImageId) {
        //   try { await storage.deleteFile(IMAGES_BUCKET_ID, oldImageId); } catch (e) {}
        // }

        const file = await storage.createFile(
          IMAGES_BUCKET_ID,
          ID.unique(),
          image,
        );

        uploadedImageUrl = `${process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT}/storage/buckets/${IMAGES_BUCKET_ID}/files/${file.$id}/view?project=${process.env.NEXT_PUBLIC_APPWRITE_PROJECT}`;
      } else {
        uploadedImageUrl = image;
      }

      const project = await databases.updateDocument(
        DATABASE_ID,
        PROJECTS_ID,
        projectId,
        {
          name,
          imageUrl: uploadedImageUrl,
        },
      );

      return c.json({ data: project });
    },
  )
  .delete("/:projectId", sessionMiddleware, async (c) => {
    const databases = c.get("databases");
    const storage = c.get("storage");
    const user = c.get("user");

    const { projectId } = c.req.param();

    const existingProject = await databases.getDocument<Project>(
      DATABASE_ID,
      PROJECTS_ID,
      projectId,
    );

    const member = await getMember({
      databases,
      workspaceId: existingProject.workspaceId,
      userId: user.$id,
    });

    if (!member) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    // 1. Delete Project Image from Storage to prevent dead files
    const imageId = extractFileIdFromUrl(existingProject.imageUrl);
    if (imageId) {
      try {
        await storage.deleteFile(IMAGES_BUCKET_ID, imageId);
      } catch (error) {
        console.error("Failed to delete project image on cascade:", error);
      }
    }

    // 2. Cascade Delete Tasks
    const tasks = await databases.listDocuments(DATABASE_ID, TASKS_ID, [
      Query.equal("projectId", projectId),
    ]);

    await Promise.all(
      tasks.documents.map((t) =>
        databases.deleteDocument(DATABASE_ID, TASKS_ID, t.$id),
      ),
    );

    // 3. Delete the Project Document
    await databases.deleteDocument(DATABASE_ID, PROJECTS_ID, projectId);

    return c.json({ data: { $id: existingProject.$id } });
  })
  .get("/:projectId/analytics", sessionMiddleware, async (c) => {
    const databases = c.get("databases");
    const user = c.get("user");
    const { projectId } = c.req.param();

    const project = await databases.getDocument<Project>(
      DATABASE_ID,
      PROJECTS_ID,
      projectId,
    );

    const member = await getMember({
      databases,
      workspaceId: project.workspaceId,
      userId: user.$id,
    });

    if (!member) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const now = new Date();
    const thisMonthStart = startOfMonth(now).toISOString();
    const thisMonthEnd = endOfMonth(now).toISOString();
    const lastMonthStart = startOfMonth(subMonths(now, 1)).toISOString();
    const lastMonthEnd = endOfMonth(subMonths(now, 1)).toISOString();

    // Run all analytics queries concurrently
    const [
      thisMonthTasks,
      lastMonthTasks,
      thisMonthAssignedTasks,
      lastMonthAssignedTasks,
      thisMonthIncompleteTasks,
      lastMonthIncompleteTasks,
      thisMonthCompletedTasks,
      lastMonthCompletedTasks,
      thisMonthOverdueTasks,
      lastMonthOverdueTasks,
    ] = await Promise.all([
      databases.listDocuments(DATABASE_ID, TASKS_ID, [
        Query.equal("projectId", projectId),
        Query.greaterThanEqual("$createdAt", thisMonthStart),
        Query.lessThanEqual("$createdAt", thisMonthEnd),
      ]),
      databases.listDocuments(DATABASE_ID, TASKS_ID, [
        Query.equal("projectId", projectId),
        Query.greaterThanEqual("$createdAt", lastMonthStart),
        Query.lessThanEqual("$createdAt", lastMonthEnd),
      ]),
      databases.listDocuments(DATABASE_ID, TASKS_ID, [
        Query.equal("projectId", projectId),
        Query.equal("assigneeId", member.$id),
        Query.greaterThanEqual("$createdAt", thisMonthStart),
        Query.lessThanEqual("$createdAt", thisMonthEnd),
      ]),
      databases.listDocuments(DATABASE_ID, TASKS_ID, [
        Query.equal("projectId", projectId),
        Query.equal("assigneeId", member.$id),
        Query.greaterThanEqual("$createdAt", lastMonthStart),
        Query.lessThanEqual("$createdAt", lastMonthEnd),
      ]),
      databases.listDocuments(DATABASE_ID, TASKS_ID, [
        Query.equal("projectId", projectId),
        Query.notEqual("status", TaskStatus.DONE),
        Query.greaterThanEqual("$createdAt", thisMonthStart),
        Query.lessThanEqual("$createdAt", thisMonthEnd),
      ]),
      databases.listDocuments(DATABASE_ID, TASKS_ID, [
        Query.equal("projectId", projectId),
        Query.notEqual("status", TaskStatus.DONE),
        Query.greaterThanEqual("$createdAt", lastMonthStart),
        Query.lessThanEqual("$createdAt", lastMonthEnd),
      ]),
      databases.listDocuments(DATABASE_ID, TASKS_ID, [
        Query.equal("projectId", projectId),
        Query.equal("status", TaskStatus.DONE),
        Query.greaterThanEqual("$createdAt", thisMonthStart),
        Query.lessThanEqual("$createdAt", thisMonthEnd),
      ]),
      databases.listDocuments(DATABASE_ID, TASKS_ID, [
        Query.equal("projectId", projectId),
        Query.equal("status", TaskStatus.DONE),
        Query.greaterThanEqual("$createdAt", lastMonthStart),
        Query.lessThanEqual("$createdAt", lastMonthEnd),
      ]),
      databases.listDocuments(DATABASE_ID, TASKS_ID, [
        Query.equal("projectId", projectId),
        Query.notEqual("status", TaskStatus.DONE),
        Query.lessThan("dueDate", now.toISOString()),
        Query.greaterThanEqual("$createdAt", thisMonthStart),
        Query.lessThanEqual("$createdAt", thisMonthEnd),
      ]),
      databases.listDocuments(DATABASE_ID, TASKS_ID, [
        Query.equal("projectId", projectId),
        Query.notEqual("status", TaskStatus.DONE),
        Query.lessThan("dueDate", now.toISOString()),
        Query.greaterThanEqual("$createdAt", lastMonthStart),
        Query.lessThanEqual("$createdAt", lastMonthEnd),
      ]),
    ]);

    return c.json({
      data: {
        taskCount: thisMonthTasks.total,
        taskDifference: thisMonthTasks.total - lastMonthTasks.total,
        assignedTaskCount: thisMonthAssignedTasks.total,
        assignedTaskDifference:
          thisMonthAssignedTasks.total - lastMonthAssignedTasks.total,
        completedTaskCount: thisMonthCompletedTasks.total,
        completedTaskDifference:
          thisMonthCompletedTasks.total - lastMonthCompletedTasks.total,
        incompleteTaskCount: thisMonthIncompleteTasks.total,
        incompleteTaskDifference:
          thisMonthIncompleteTasks.total - lastMonthIncompleteTasks.total,
        overdueTaskCount: thisMonthOverdueTasks.total,
        overdueTaskDifference:
          thisMonthOverdueTasks.total - lastMonthOverdueTasks.total,
      },
    });
  });

export default app;
