"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRight, Info, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { useTournamentStore } from "@/application/tournament/store";
import { createCardSchema, type CreateCardForm } from "@/domain/tournament/schemas";
import type { PairingRuleType } from "@/domain/tournament/types";
import { Button } from "@/ui/components/button";
import { EmptyState, PageHeader, Panel } from "@/ui/components/page";
import { LockKeyhole } from "lucide-react";

const ruleLabels: Record<PairingRuleType, string> = {
  SWISS: "Swiss — จับคู่ตามคะแนนและผลต่าง",
  KING_OF_THE_HILL: "King of the Hill — อันดับใกล้กันพบกัน",
  PAIR_RESULT: "Pair Result — ผู้ชนะพบผู้ชนะในเกมถัดไป",
};

export default function CreateCardPage() {
  const router = useRouter();
  const createCard = useTournamentStore((state) => state.createCard);
  const auth = useTournamentStore((state) => state.auth);
  const loading = useTournamentStore((state) => state.loading);
  const [rules, setRules] = useState<PairingRuleType[]>(["SWISS", "SWISS", "SWISS"]);
  const [gameMaxDiffs, setGameMaxDiffs] = useState<number[]>([350, 350, 350, 350]);
  const { register, handleSubmit, watch, formState: { errors, isSubmitting } } = useForm<CreateCardForm>({
    resolver: zodResolver(createCardSchema),
    defaultValues: { name: "", division: "", numberOfGames: 4 },
  });
  const numberOfGames = Number(watch("numberOfGames")) || 2;

  useEffect(() => {
    setRules((current) => Array.from({ length: Math.max(1, numberOfGames - 1) }, (_, index) => current[index] ?? "SWISS"));
    setGameMaxDiffs((current) => Array.from({ length: numberOfGames }, (_, index) => current[index] ?? 350));
  }, [numberOfGames]);

  const onSubmit = async (values: CreateCardForm) => {
    const chainedPairResult = rules.some((rule, index) => rule === "PAIR_RESULT" && rules[index - 1] === "PAIR_RESULT");
    if (chainedPairResult) {
      window.alert("PAIR_RESULT เชื่อมต่อกันเกิน 2 เกมไม่ได้ กรุณาเลือกกติกาอื่นคั่นระหว่างชุด");
      return;
    }
    try {
      const id = await createCard({ ...values, rules, gameMaxDiffs });
      router.push(`/cards/${id}/players`);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "ไม่สามารถสร้างการ์ดได้");
    }
  };

  if (loading) return <div className="panel panel-padding">กำลังตรวจสอบสิทธิ์…</div>;
  if (!auth.authenticated || !auth.roles.includes("ROLE_STAFF")) {
    return <div className="panel"><EmptyState icon={<LockKeyhole size={25} />} title="สำหรับเจ้าหน้าที่เท่านั้น" description="เข้าสู่ระบบด้วยบัญชีเจ้าหน้าที่เพื่อสร้างการ์ดการแข่งขัน" action={<Link href="/staff-login"><Button>เข้าสู่ระบบเจ้าหน้าที่</Button></Link>} /></div>;
  }

  return (
    <>
      <PageHeader eyebrow="New competition" title="สร้างการ์ดการแข่งขัน" description="ระบบจะสร้างเกมและเส้นเชื่อมอัตโนมัติตามจำนวนเกมที่กำหนด" />
      <form onSubmit={handleSubmit(onSubmit)}>
        <Panel title="ข้อมูลการแข่งขัน" description="การ์ดหนึ่งใบใช้สำหรับหนึ่งรุ่นการแข่งขัน">
          <div className="panel-padding form-grid">
            <div className="form-field">
              <label className="form-label" htmlFor="name">ชื่อการแข่งขัน <span className="required">*</span></label>
              <input className="input" id="name" placeholder="เช่น A-Math Championship" {...register("name")} />
              {errors.name && <p className="form-error">{errors.name.message}</p>}
            </div>
            <div className="form-field">
              <label className="form-label" htmlFor="division">รุ่นการแข่งขัน <span className="required">*</span></label>
              <input className="input" id="division" placeholder="เช่น ประถมศึกษา" {...register("division")} />
              {errors.division && <p className="form-error">{errors.division.message}</p>}
            </div>
            <div className="form-field">
              <label className="form-label" htmlFor="numberOfGames">จำนวนเกม <span className="required">*</span></label>
              <select className="select" id="numberOfGames" {...register("numberOfGames")}>
                {Array.from({ length: 11 }, (_, index) => index + 2).map((count) => <option value={count} key={count}>{count} เกม</option>)}
              </select>
              {errors.numberOfGames && <p className="form-error">{errors.numberOfGames.message}</p>}
            </div>
          </div>
        </Panel>

        <Panel title="Maximum Difference รายเกม" description="ผลต่างของผู้ชนะและผู้แพ้จะถูกจำกัดตามค่านี้ คะแนนดิบยังถูกเก็บครบ">
          <div className="max-diff-grid panel-padding">
            {gameMaxDiffs.map((maxDiff, index) => (
              <div className="form-field" key={index}>
                <label className="form-label" htmlFor={`max-diff-${index + 1}`}>เกม {index + 1} · Max diff</label>
                <input
                  className="input"
                  id={`max-diff-${index + 1}`}
                  type="number"
                  min={1}
                  max={1000000}
                  required
                  value={maxDiff}
                  onChange={(event) => setGameMaxDiffs((current) => current.map((value, gameIndex) => gameIndex === index ? Number(event.target.value) : value))}
                />
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="ลำดับเกมและกติกาการจับคู่" description="ทุกเส้นเชื่อมต้องมีกติกาหนึ่งรายการก่อนบันทึก">
          <div className="notice notice--info" style={{ margin: 18 }}><Info size={18} /><p><strong>กติกามีผลกับเกมถัดไป</strong><span>ตัวอย่าง: กติกาบนเส้น เกม 1 → เกม 2 ใช้สร้างคู่แข่งขันของเกม 2</span></p></div>
          <div className="rule-list">
            {rules.map((rule, index) => (
              <div className="rule-row" key={index}>
                <div className="game-box">เกม {index + 1}</div>
                <ArrowRight className="rule-arrow" size={17} />
                <div className="game-box">เกม {index + 2}</div>
                <select
                  aria-label={`กติกาจากเกม ${index + 1} ไปเกม ${index + 2}`}
                  className="select"
                  value={rule}
                  onChange={(event) => setRules((current) => current.map((value, ruleIndex) => ruleIndex === index ? event.target.value as PairingRuleType : value))}
                >
                  {Object.entries(ruleLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                </select>
              </div>
            ))}
          </div>
          <div className="form-actions">
            <Link href="/cards"><Button type="button" variant="secondary">ยกเลิก</Button></Link>
            <Button type="submit" disabled={isSubmitting || rules.some((rule) => !rule) || gameMaxDiffs.some((value) => !Number.isInteger(value) || value < 1 || value > 1000000)}><Save size={16} />บันทึกการ์ด</Button>
          </div>
        </Panel>
      </form>
    </>
  );
}
