import Image from "next/image";
import Link from "next/link";

import { UserButton } from "@/features/auth/components/user-button";

interface StandloneLayoutProps {
  children: React.ReactNode;
}

const StandloneLayout = ({ children }: StandloneLayoutProps) => {
  return (
    <main className="bg-neutral-100 min-h-screen">
      <div className="mx-auto max-w-screen-2xl p-4">
        <nav className="flex justify-between items-center h-[73px]">
          <Link
            href="/"
            className="flex items-center pt-2 pb-1 transition-opacity hover:opacity-80"
          >
            <Image
              src="/logo.png"
              alt="TaskPilot Logo"
              width={164}
              height={48}
              priority
              // Removed "h-8" so it uses your exact 164x48 dimensions
              className="w-auto object-contain"
            />
          </Link>
          <UserButton />
        </nav>
        <div className="flex flex-col items-center justify-center py-4">
          {children}
        </div>
      </div>
    </main>
  );
};

export default StandloneLayout;
