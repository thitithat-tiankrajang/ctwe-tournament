import Link from "next/link";
import { FileQuestion } from "lucide-react";
import { Button } from "./button";
import { EmptyState } from "./page";

export function CardNotFound() {
  return <EmptyState icon={<FileQuestion size={25} />} title="ไม่พบการ์ดการแข่งขัน" description="การ์ดนี้อาจถูกลบหรือข้อมูลในเบราว์เซอร์ถูกรีเซ็ต" action={<Link prefetch={false} href="/cards"><Button>กลับไปการ์ดทั้งหมด</Button></Link>} />;
}
