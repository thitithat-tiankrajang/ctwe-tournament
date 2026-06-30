"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { LinkIcon, LockKeyhole } from "lucide-react";
import { useEffect, useState } from "react";
import { useTournamentStore } from "@/application/tournament/store";
import { Button } from "@/ui/components/button";
import { EmptyState } from "@/ui/components/page";

/**
 * Private tournament entry. Resolving the token scopes the visitor to that OPEN tournament and sends
 * them to its card list. A missing/CLOSED token 404s, so the link is dead until an admin re-opens it.
 */
export default function TournamentLinkPage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const resolveTournamentToken = useTournamentStore((state) => state.resolveTournamentToken);
  const setActiveTournament = useTournamentStore((state) => state.setActiveTournament);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const tournament = await resolveTournamentToken(token);
        if (!active) return;
        setActiveTournament({ id: tournament.id, name: tournament.name });
        router.replace("/cards");
      } catch {
        if (active) setError(true);
      }
    })();
    return () => { active = false; };
  }, [token, resolveTournamentToken, setActiveTournament, router]);

  if (error) {
    return (
      <div className="panel">
        <EmptyState
          icon={<LockKeyhole size={25} />}
          title="ลิงก์นี้ใช้ไม่ได้"
          description="การแข่งขันนี้อาจยังไม่เปิดให้เข้าชม หรือถูกปิดไปแล้ว — โปรดติดต่อผู้จัดการแข่งขัน"
          action={<Link href="/"><Button variant="secondary"><LinkIcon size={16} />ไปหน้ารวมการแข่งขัน</Button></Link>}
        />
      </div>
    );
  }
  return <div className="panel panel-padding">กำลังเข้าสู่การแข่งขัน…</div>;
}
