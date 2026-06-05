import { z } from "zod";
import { Hono } from "hono";
import { ID, Query } from "node-appwrite";
import { zValidator } from "@hono/zod-validator";
import { endOfMonth, startOfMonth, subMonths } from "date-fns";

import { MemberRole } from "@/features/members/types";
import { TaskStatus } from "@/features/tasks/types";
import { getMember } from "@/features/members/utils";

import { generateInviteCode } from "@/lib/utils";
import { sessionMiddleware } from "@/lib/session-middleware";
import {
  DATABASE_ID,
  IMAGES_BUCKET_ID,
  MEMBERS_ID,
  TASKS_ID,
  WORKSPACES_ID,
} from "@/config";

import { Workspace } from "../types";
import { createWorkspaceSchema, updateWorkspaceSchema } from "../schemas";

// --- Helper Functions ---

// Extracts the Appwrite File ID from the View URL so we can delete it later
const extractFileIdFromUrl = (url?: string | null) => {
  if (!url) return null;
  const match = url.match(/\/files\/([a-zA-Z0-9_-]+)\/view/);
  return match ? match[1] : null;
};

// --- Router ---

const app = new Hono()
  .get("/", sessionMiddleware, async (c) => {
    const user = c.get("user");
    const databases = c.get("databases");

    const members = await databases.listDocuments(DATABASE_ID, MEMBERS_ID, [
      Query.equal("userId", user.$id),
    ]);

    if (members.total === 0) {
      return c.json({ data: { documents: [], total: 0 } });
    }

    const workspaceIds = members.documents.map((member) => member.workspaceId);

    const workspaces = await databases.listDocuments(
      DATABASE_ID,
      WORKSPACES_ID,
      [Query.orderDesc("$createdAt"), Query.contains("$id", workspaceIds)],
    );

    return c.json({ data: workspaces });
  })

  .get("/:workspaceId", sessionMiddleware, async (c) => {
    const user = c.get("user");
    const databases = c.get("databases");
    const { workspaceId } = c.req.param();

    const member = await getMember({
      databases,
      workspaceId,
      userId: user.$id,
    });

    if (!member) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const workspace = await databases.getDocument<Workspace>(
      DATABASE_ID,
      WORKSPACES_ID,
      workspaceId,
    );

    return c.json({ data: workspace });
  })

  .get("/:workspaceId/info", sessionMiddleware, async (c) => {
    const databases = c.get("databases");
    const { workspaceId } = c.req.param();

    const workspace = await databases.getDocument<Workspace>(
      DATABASE_ID,
      WORKSPACES_ID,
      workspaceId,
    );

    return c.json({
      data: {
        $id: workspace.$id,
        name: workspace.name,
        imageUrl: workspace.imageUrl,
      },
    });
  })

  .post(
    "/",
    zValidator("form", createWorkspaceSchema),
    sessionMiddleware,
    async (c) => {
      const databases = c.get("databases");
      const storage = c.get("storage");
      const user = c.get("user");

      const { name, image } = c.req.valid("form");

      let uploadedImageUrl: string | undefined;

      if (image instanceof File) {
        const file = await storage.createFile(
          IMAGES_BUCKET_ID,
          ID.unique(),
          image,
        );

        uploadedImageUrl = `${process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT}/storage/buckets/${IMAGES_BUCKET_ID}/files/${file.$id}/view?project=${process.env.NEXT_PUBLIC_APPWRITE_PROJECT}`;
      } else {
        uploadedImageUrl = image;
      }

      const workspace = await databases.createDocument(
        DATABASE_ID,
        WORKSPACES_ID,
        ID.unique(),
        {
          name,
          userId: user.$id,
          imageUrl: uploadedImageUrl,
          inviteCode: generateInviteCode(6),
        },
      );

      await databases.createDocument(DATABASE_ID, MEMBERS_ID, ID.unique(), {
        userId: user.$id,
        workspaceId: workspace.$id,
        role: MemberRole.ADMIN,
      });

      return c.json({ data: workspace });
    },
  )

  .patch(
    "/:workspaceId",
    sessionMiddleware,
    zValidator("form", updateWorkspaceSchema),
    async (c) => {
      const databases = c.get("databases");
      const storage = c.get("storage");
      const user = c.get("user");

      const { workspaceId } = c.req.param();
      const { name, image } = c.req.valid("form");

      const member = await getMember({
        databases,
        workspaceId,
        userId: user.$id,
      });

      if (!member || member.role !== MemberRole.ADMIN) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      let uploadedImageUrl: string | undefined;

      if (image instanceof File) {
        // Optional: If you want to prevent storage leaks when a user updates their image,
        // you can fetch the existing workspace here and delete the old image from the bucket.
        const file = await storage.createFile(
          IMAGES_BUCKET_ID,
          ID.unique(),
          image,
        );

        uploadedImageUrl = `${process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT}/storage/buckets/${IMAGES_BUCKET_ID}/files/${file.$id}/view?project=${process.env.NEXT_PUBLIC_APPWRITE_PROJECT}`;
      } else {
        uploadedImageUrl = image;
      }

      const workspace = await databases.updateDocument(
        DATABASE_ID,
        WORKSPACES_ID,
        workspaceId,
        {
          name,
          imageUrl: uploadedImageUrl,
        },
      );

      return c.json({ data: workspace });
    },
  )

  .delete("/:workspaceId", sessionMiddleware, async (c) => {
    const databases = c.get("databases");
    const storage = c.get("storage");
    const user = c.get("user");

    const { workspaceId } = c.req.param();

    const member = await getMember({
      databases,
      workspaceId,
      userId: user.$id,
    });

    if (!member || member.role !== MemberRole.ADMIN) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const workspace = await databases.getDocument<Workspace>(
      DATABASE_ID,
      WORKSPACES_ID,
      workspaceId,
    );

    // 1. Delete Workspace Image from Storage to prevent dead files
    const imageId = extractFileIdFromUrl(workspace.imageUrl);
    if (imageId) {
      try {
        await storage.deleteFile(IMAGES_BUCKET_ID, imageId);
      } catch (error) {
        console.error("Failed to delete workspace image on cascade:", error);
      }
    }

    // 2. Cascade Delete Tasks & Members
    const [tasks, members] = await Promise.all([
      databases.listDocuments(DATABASE_ID, TASKS_ID, [
        Query.equal("workspaceId", workspaceId),
      ]),
      databases.listDocuments(DATABASE_ID, MEMBERS_ID, [
        Query.equal("workspaceId", workspaceId),
      ]),
    ]);

    await Promise.all([
      ...tasks.documents.map((t) =>
        databases.deleteDocument(DATABASE_ID, TASKS_ID, t.$id),
      ),
      ...members.documents.map((m) =>
        databases.deleteDocument(DATABASE_ID, MEMBERS_ID, m.$id),
      ),
    ]);

    // 3. Delete the Workspace Document
    await databases.deleteDocument(DATABASE_ID, WORKSPACES_ID, workspaceId);

    return c.json({ data: { $id: workspaceId } });
  })

  .post("/:workspaceId/reset-invite-code", sessionMiddleware, async (c) => {
    const databases = c.get("databases");
    const user = c.get("user");

    const { workspaceId } = c.req.param();

    const member = await getMember({
      databases,
      workspaceId,
      userId: user.$id,
    });

    if (!member || member.role !== MemberRole.ADMIN) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const workspace = await databases.updateDocument(
      DATABASE_ID,
      WORKSPACES_ID,
      workspaceId,
      {
        inviteCode: generateInviteCode(6),
      },
    );

    return c.json({ data: workspace });
  })

  .post(
    "/:workspaceId/join",
    sessionMiddleware,
    zValidator("json", z.object({ code: z.string() })),
    async (c) => {
      const { workspaceId } = c.req.param();
      const { code } = c.req.valid("json");

      const databases = c.get("databases");
      const user = c.get("user");

      const member = await getMember({
        databases,
        workspaceId,
        userId: user.$id,
      });

      if (member) {
        return c.json({ error: "Already a member" }, 400);
      }

      const workspace = await databases.getDocument<Workspace>(
        DATABASE_ID,
        WORKSPACES_ID,
        workspaceId,
      );

      if (workspace.inviteCode !== code) {
        return c.json({ error: "Invalid invite code" }, 400);
      }

      await databases.createDocument(DATABASE_ID, MEMBERS_ID, ID.unique(), {
        workspaceId,
        userId: user.$id,
        role: MemberRole.MEMBER,
      });

      return c.json({ data: workspace });
    },
  )

  .get("/:workspaceId/analytics", sessionMiddleware, async (c) => {
    const databases = c.get("databases");
    const user = c.get("user");
    const { workspaceId } = c.req.param();

    const member = await getMember({
      databases,
      workspaceId,
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
        Query.equal("workspaceId", workspaceId),
        Query.greaterThanEqual("$createdAt", thisMonthStart),
        Query.lessThanEqual("$createdAt", thisMonthEnd),
      ]),
      databases.listDocuments(DATABASE_ID, TASKS_ID, [
        Query.equal("workspaceId", workspaceId),
        Query.greaterThanEqual("$createdAt", lastMonthStart),
        Query.lessThanEqual("$createdAt", lastMonthEnd),
      ]),
      databases.listDocuments(DATABASE_ID, TASKS_ID, [
        Query.equal("workspaceId", workspaceId),
        Query.equal("assigneeId", member.$id),
        Query.greaterThanEqual("$createdAt", thisMonthStart),
        Query.lessThanEqual("$createdAt", thisMonthEnd),
      ]),
      databases.listDocuments(DATABASE_ID, TASKS_ID, [
        Query.equal("workspaceId", workspaceId),
        Query.equal("assigneeId", member.$id),
        Query.greaterThanEqual("$createdAt", lastMonthStart),
        Query.lessThanEqual("$createdAt", lastMonthEnd),
      ]),
      databases.listDocuments(DATABASE_ID, TASKS_ID, [
        Query.equal("workspaceId", workspaceId),
        Query.notEqual("status", TaskStatus.DONE),
        Query.greaterThanEqual("$createdAt", thisMonthStart),
        Query.lessThanEqual("$createdAt", thisMonthEnd),
      ]),
      databases.listDocuments(DATABASE_ID, TASKS_ID, [
        Query.equal("workspaceId", workspaceId),
        Query.notEqual("status", TaskStatus.DONE),
        Query.greaterThanEqual("$createdAt", lastMonthStart),
        Query.lessThanEqual("$createdAt", lastMonthEnd),
      ]),
      databases.listDocuments(DATABASE_ID, TASKS_ID, [
        Query.equal("workspaceId", workspaceId),
        Query.equal("status", TaskStatus.DONE),
        Query.greaterThanEqual("$createdAt", thisMonthStart),
        Query.lessThanEqual("$createdAt", thisMonthEnd),
      ]),
      databases.listDocuments(DATABASE_ID, TASKS_ID, [
        Query.equal("workspaceId", workspaceId),
        Query.equal("status", TaskStatus.DONE),
        Query.greaterThanEqual("$createdAt", lastMonthStart),
        Query.lessThanEqual("$createdAt", lastMonthEnd),
      ]),
      databases.listDocuments(DATABASE_ID, TASKS_ID, [
        Query.equal("workspaceId", workspaceId),
        Query.notEqual("status", TaskStatus.DONE),
        Query.lessThan("dueDate", now.toISOString()),
        Query.greaterThanEqual("$createdAt", thisMonthStart),
        Query.lessThanEqual("$createdAt", thisMonthEnd),
      ]),
      databases.listDocuments(DATABASE_ID, TASKS_ID, [
        Query.equal("workspaceId", workspaceId),
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
