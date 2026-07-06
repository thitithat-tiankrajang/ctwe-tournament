"use client";

import Link from "next/link";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRight, Info, Save, Trophy } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { useTournamentStore } from "@/application/tournament/store";
import { appDialog } from "@/application/ui/dialog";
import { createCardSchema, type CreateCardForm } from "@/domain/tournament/schemas";
import type { FinalType, PairingRuleType, Tournament } from "@/domain/tournament/types";
import { Button } from "@/ui/components/button";
import { Panel } from "@/ui/components/page";

const ruleLabels: Record<PairingRuleType, string> = {
  RANDOM: "Random — สุ่มใหม่ พร้อมกระจายสถาบันระดับคู่และโต๊ะ",
  SWISS: "Swiss — จับคู่ตามคะแนนและผลต่าง",
  KING_OF_THE_HILL: "King of the Hill — อันดับใกล้กันพบกัน",
  PAIR_RESULT: "แพ้เจอแพ้ / ชนะเจอชนะ — กรอกผล 2 เกมเป็นหนึ่งชุด",
};

interface CardCreateFormProps {
  /** When provided, a tournament selector is shown (e.g. the director's tournaments). */
  tournaments?: Tournament[];
  /** When provided, the tournament is fixed (read-only display). */
  fixedTournament?: { id: string; name: string };
  onCreated: (cardId: string, tournament: { id: string; name: string }) => void;
  cancelHref?: string;
}

export function CardCreateForm({ tournaments, fixedTournament, onCreated, cancelHref }: CardCreateFormProps) {
  const createCard = useTournamentStore((state) => state.createCard);
  const [rules, setRules] = useState<PairingRuleType[]>(["SWISS", "SWISS", "SWISS"]);
  const [gameMaxDiffs, setGameMaxDiffs] = useState<number[]>([350, 350, 350, 350]);
  const [finalType, setFinalType] = useState<FinalType>("NONE");
  const [finalGames, setFinalGames] = useState<number>(1);
  const [gibsonEnabled, setGibsonEnabled] = useState(false);
  const [tournamentId, setTournamentId] = useState(fixedTournament?.id ?? "");
  const { register, handleSubmit, watch, formState: { errors, isSubmitting } } = useForm<CreateCardForm>({
    resolver: zodResolver(createCardSchema),
    defaultValues: { name: "", division: "", numberOfGames: 4 },
  });
  const numberOfGames = Number(watch("numberOfGames")) || 2;

  useEffect(() => {
    setRules((current) => Array.from({ length: Math.max(1, numberOfGames - 1) }, (_, index) => current[index] ?? "SWISS"));
    setGameMaxDiffs((current) => Array.from({ length: numberOfGames }, (_, index) => current[index] ?? 350));
  }, [numberOfGames]);

  useEffect(() => {
    if (fixedTournament) setTournamentId(fixedTournament.id);
    else if (tournaments && tournaments.length > 0) setTournamentId((current) => current || tournaments[0].id);
  }, [fixedTournament, tournaments]);

  const resolveTournament = (): { id: string; name: string } | null => {
    if (fixedTournament) return fixedTournament;
    const match = tournaments?.find((item) => item.id === tournamentId);
    return match ? { id: match.id, name: match.name } : null;
  };

  const onSubmit = async (values: CreateCardForm) => {
    if (rules.some((rule, index) => rule === "PAIR_RESULT" && rules[index - 1] === "PAIR_RESULT")) {
      await appDialog.alert("PAIR_RESULT เชื่อมต่อกันเกิน 2 เกมไม่ได้ กรุณาเลือกกติกาอื่นคั่นระหว่างชุด", "กติกา Pairing ไม่ถูกต้อง", true);
      return;
    }
    const tour = resolveTournament();
    if (!tour) { await appDialog.alert("กรุณาเลือกรายการแข่งขัน (tournament) ก่อนสร้างการ์ด"); return; }
    try {
      const id = await createCard({ tournamentId: tour.id, ...values, rules, gameMaxDiffs, finalType, finalGames: finalType === "NONE" ? 0 : finalGames, gibsonEnabled });
      onCreated(id, tour);
    } catch (error) {
      await appDialog.alert(error instanceof Error ? error.message : "ไม่สามารถสร้างการ์ดได้", "สร้างการ์ดไม่สำเร็จ", true);
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <Panel title="ข้อมูลการแข่งขัน" description="การ์ดหนึ่งใบใช้สำหรับหนึ่งรุ่นการแข่งขัน">
        <div className="panel-padding form-grid">
          <div className="form-field">
            <label className="form-label" htmlFor="cf-tour">รายการแข่งขัน (Tournament) <span className="required">*</span></label>
            {fixedTournament ? (
              <div className="input" style={{ display: "flex", alignItems: "center", gap: 8 }}><Trophy size={15} />{fixedTournament.name}</div>
            ) : (
              <>
                <select className="select" id="cf-tour" value={tournamentId} onChange={(event) => setTournamentId(event.target.value)}>
                  <option value="" disabled>เลือกรายการแข่งขัน…</option>
                  {tournaments?.map((item) => <option key={item.id} value={item.id}>{item.name}{item.status === "CLOSED" ? " (ปิดอยู่)" : ""}</option>)}
                </select>
                {tournaments && tournaments.length === 0 && <p className="form-error">คุณยังไม่ได้รับมอบหมายรายการแข่งขัน</p>}
              </>
            )}
          </div>
          <div className="form-field">
            <label className="form-label" htmlFor="cf-name">ชื่อการแข่งขัน <span className="required">*</span></label>
            <input className="input" id="cf-name" placeholder="เช่น A-Math Championship" {...register("name")} />
            {errors.name && <p className="form-error">{errors.name.message}</p>}
          </div>
          <div className="form-field">
            <label className="form-label" htmlFor="cf-division">รุ่นการแข่งขัน <span className="required">*</span></label>
            <input className="input" id="cf-division" placeholder="เช่น ประถมศึกษา" {...register("division")} />
            {errors.division && <p className="form-error">{errors.division.message}</p>}
          </div>
          <div className="form-field">
            <label className="form-label" htmlFor="cf-games">จำนวนเกม <span className="required">*</span></label>
            <select className="select" id="cf-games" {...register("numberOfGames")}>
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
              <label className="form-label" htmlFor={`cf-max-diff-${index + 1}`}>เกม {index + 1} · Max diff</label>
              <input className="input" id={`cf-max-diff-${index + 1}`} type="number" min={1} max={1000000} required value={maxDiff}
                onChange={(event) => setGameMaxDiffs((current) => current.map((value, gameIndex) => gameIndex === index ? Number(event.target.value) : value))} />
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="รอบชิงชนะเลิศ" description="เลือกได้ว่ามีรอบตัดสินอันดับหรือไม่ — ผู้เข้าชิงมาจากอันดับท้ายเกมสุดท้าย รอบชิงไม่มี max diff และสรุปผู้ชนะเอง">
        <div className="panel-padding form-grid">
          <div className="form-field">
            <label className="form-label" htmlFor="cf-final-type">รูปแบบรอบชิง</label>
            <select className="select" id="cf-final-type" value={finalType} onChange={(event) => setFinalType(event.target.value as FinalType)}>
              <option value="NONE">ไม่มีรอบชิง</option>
              <option value="CHAMPION">ชิงที่ 1 — อันดับ 1,2 เข้าชิง (ชนะ = ที่ 1, แพ้ = ที่ 2)</option>
              <option value="CHAMPION_AND_THIRD">ชิงที่ 1 และ 3 — เพิ่มอันดับ 3,4 ชิงที่ 3 (ชนะ = ที่ 3, แพ้ = ที่ 4)</option>
            </select>
          </div>
          {finalType !== "NONE" && (
            <div className="form-field">
              <label className="form-label" htmlFor="cf-final-games">จำนวนเกมรอบชิง</label>
              <input className="input" id="cf-final-games" type="number" min={1} max={12} value={finalGames}
                onChange={(event) => setFinalGames(Math.max(1, Math.min(12, Number(event.target.value) || 1)))} />
            </div>
          )}
          <div className="form-field" style={{ gridColumn: "1 / -1" }}>
            <label className="form-label" style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
              <input type="checkbox" checked={gibsonEnabled} onChange={(event) => setGibsonEnabled(event.target.checked)} />
              เปิดใช้ Gibsonization (Gibson Pairing)
            </label>
            <small className="muted">เมื่อระบบพิสูจน์ได้ว่ามีผู้เล่นการันตีแชมป์/เข้ารอบแน่นอนแล้ว จะจับคู่ผู้เล่นคนนั้นกับผู้ที่หมดลุ้นรางวัล เพื่อไม่ให้คะแนนไปกระทบลำดับกลุ่มที่ยังลุ้นอยู่ (คำนวณจาก max diff และเกมที่เหลือ)</small>
          </div>
        </div>
      </Panel>

      <Panel title="ลำดับเกมและกติกาการจับคู่" description="ทุกเส้นเชื่อมต้องมีกติกาหนึ่งรายการก่อนบันทึก">
        <div className="notice notice--info" style={{ margin: 18 }}><Info size={18} /><p><strong>กติกามีผลกับเกมถัดไป</strong><span>ตัวอย่าง: กติกาบนเส้น เกม 1 → เกม 2 ใช้สร้างคู่แข่งขันของเกม 2</span></p></div>
        {rules.includes("PAIR_RESULT") && <div className="notice notice--warning" style={{ margin: 18 }}><Info size={18} /><p><strong>แพ้เจอแพ้ / ชนะเจอชนะ รองรับจำนวนผู้เล่นทุกจำนวน</strong><span>เจ้าหน้าที่จะกรอกผลทั้ง Game ต้นทางและ Game ถัดไปในชุดเดียวกัน ระบบสร้างคู่บายและจัดกลุ่มเศษให้อัตโนมัติ · ห้ามเลือกกติกานี้ต่อกันสองเส้น</span></p></div>}
        <div className="rule-list">
          {rules.map((rule, index) => (
            <div className="rule-row" key={index}>
              <div className="game-box">เกม {index + 1}</div>
              <ArrowRight className="rule-arrow" size={17} />
              <div className="game-box">เกม {index + 2}</div>
              <select aria-label={`กติกาจากเกม ${index + 1} ไปเกม ${index + 2}`} className="select" value={rule}
                onChange={(event) => setRules((current) => current.map((value, ruleIndex) => ruleIndex === index ? event.target.value as PairingRuleType : value))}>
                {Object.entries(ruleLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
              </select>
            </div>
          ))}
        </div>
        <div className="form-actions">
          {cancelHref && <Link prefetch={false} href={cancelHref}><Button type="button" variant="secondary">ยกเลิก</Button></Link>}
          <Button type="submit" disabled={isSubmitting || (!fixedTournament && !tournamentId) || rules.some((rule) => !rule) || gameMaxDiffs.some((value) => !Number.isInteger(value) || value < 1 || value > 1000000)}><Save size={16} />บันทึกการ์ด</Button>
        </div>
      </Panel>
    </form>
  );
}
