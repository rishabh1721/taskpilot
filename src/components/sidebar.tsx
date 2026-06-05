import Image from "next/image";
import Link from "next/link";

import { Projects } from "./projects";
import { Navigation } from "./navigation";
import { DottedSeparator } from "./dotted-separator";
import { WorkspaceSwitcher } from "./workspace-switcher";

export const Sidebar = () => {
  return (
    <aside className="flex h-full w-full flex-col overflow-y-auto border-r border-border bg-muted/20 p-4 hide-scrollbar">
      <Link
        href="/"
        className="flex items-center pt-2 pb-1 transition-opacity hover:opacity-80"
      >
        <Image
          src="/logo.png"
          alt="TaskPilot Logo"
          width={220}
          height={64}
          priority
          // Removed "h-8" so it uses your exact 164x48 dimensions
          className="w-auto object-contain"
        />
      </Link>

      <DottedSeparator className="my-4" />

      <div className="flex flex-1 flex-col gap-y-4">
        <WorkspaceSwitcher />
        <Navigation />
        <Projects />
      </div>
    </aside>
  );
};
