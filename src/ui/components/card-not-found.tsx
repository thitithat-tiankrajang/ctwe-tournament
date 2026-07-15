"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { FileQuestion } from "lucide-react";
import { Button } from "./button";
import { EmptyState } from "./page";

export function CardNotFound() {
  const pathname = usePathname();
  // Inside the public viewer (/tour, /t) "back" means the hash-based card list — /cards would
  // bounce an anonymous visitor to the login gate.
  const inPublicViewer = pathname.startsWith("/tour/") || pathname.startsWith("/t/");
  const backToViewerList = () => {
    window.history.pushState(null, "", window.location.pathname + window.location.search);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  };
  return (
    <EmptyState
      icon={<FileQuestion size={25} />}
      title="ไม่พบการ์ดการแข่งขัน"
      description="การ์ดนี้อาจถูกลบหรือข้อมูลในเบราว์เซอร์ถูกรีเซ็ต"
      action={inPublicViewer
        ? <Button onClick={backToViewerList}>กลับไปเลือกรุ่นการแข่งขัน</Button>
        : <Link prefetch={false} href="/cards"><Button>กลับไปการ์ดทั้งหมด</Button></Link>}
    />
  );
}
