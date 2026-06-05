import { EditTaskModal } from "@/features/tasks/components/edit-task-modal";
import { CreateTaskModal } from "@/features/tasks/components/create-task-modal";
import { CreateProjectModal } from "@/features/projects/components/create-project-modal";
import { CreateWorkspaceModal } from "@/features/workspaces/components/create-workspace-modal";

import { Navbar } from "@/components/navbar";
import { Sidebar } from "@/components/sidebar";

interface DashboardLayoutProps {
  children: React.ReactNode;
}

const DashboardLayout = ({ children }: DashboardLayoutProps) => {
  return (
    <div className="min-h-screen bg-background">
      {/* Modals mounted at the root of the dashboard */}
      <CreateWorkspaceModal />
      <CreateProjectModal />
      <CreateTaskModal />
      <EditTaskModal />

      <div className="flex h-full w-full">
        {/* Fixed Sidebar Wrapper */}
        <div className="fixed bottom-0 left-0 top-0 hidden lg:block lg:w-[264px]">
          <Sidebar />
        </div>

        {/* Main Content Wrapper */}
        <div className="flex flex-1 flex-col w-full lg:pl-[264px]">
          <div className="mx-auto flex h-full w-full max-w-screen-2xl flex-col">
            <Navbar />
            {/* Responsive padding for a polished layout */}
            <main className="flex flex-1 flex-col px-4 py-8 sm:px-6 lg:px-8">
              {children}
            </main>
          </div>
        </div>
      </div>
    </div>
  );
};

export default DashboardLayout;
