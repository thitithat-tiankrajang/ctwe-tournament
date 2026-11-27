"use client";

import Link from "next/link";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRight } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { useTournamentStore } from "@/application/tournament/store";
import { appDialog } from "@/application/ui/dialog";
import { createCardSchema, type CreateCardForm } from "@/domain/tournament/schemas";
import type { FinalType, PairingRuleType, SlotLabel, Tournament } from "@/domain/tournament/types";
import { SelectMenu } from "@/ui/components/select-menu";

type InitialPairingRule = Exclude<PairingRuleType, "PAIR_RESULT">;

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
  const [initialPairingRule, setInitialPairingRule] = useState<InitialPairingRule>("RANDOM");
  const [rules, setRules] = useState<PairingRuleType[]>(["SWISS", "SWISS", "SWISS"]);
  const [gameMaxDiffs, setGameMaxDiffs] = useState<string[]>(["350", "350", "350", "350"]);
  const [finalType, setFinalType] = useState<FinalType>("NONE");
  const [finalGames, setFinalGames] = useState("1");
  const [gibsonEnabled, setGibsonEnabled] = useState(false);
  const [slotLabel, setSlotLabel] = useState<SlotLabel>("PAIR");
  const [tournamentId, setTournamentId] = useState(fixedTournament?.id ?? "");
  const { register, handleSubmit, setValue, watch, formState: { errors, isSubmitting } } = useForm<CreateCardForm>({
    resolver: zodResolver(createCardSchema),
    defaultValues: { name: "", division: "", numberOfGames: 4 },
  });
  const numberOfGames = Number(watch("numberOfGames")) || 2;

  useEffect(() => {
    setRules((current) => Array.from({ length: Math.max(1, numberOfGames - 1) }, (_, index) => current[index] ?? "SWISS"));
    setGameMaxDiffs((current) => Array.from({ length: numberOfGames }, (_, index) => current[index] ?? "350"));
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
      const id = await createCard({ tournamentId: tour.id, ...values, initialPairingRule, rules, gameMaxDiffs: gameMaxDiffs.map(Number), finalType, finalGames: finalType === "NONE" ? 0 : Number(finalGames), gibsonEnabled, slotLabel });
      onCreated(id, tour);
    } catch (error) {
      await appDialog.alert(error instanceof Error ? error.message : "ไม่สามารถสร้างการ์ดได้", "สร้างการ์ดไม่สำเร็จ", true);
    }
  };

  const invalidMaxDiffs = gameMaxDiffs.length !== numberOfGames || gameMaxDiffs.some((value) => !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 1_000_000);
  const invalidFinal = finalType !== "NONE" && (!/^\d+$/.test(finalGames) || Number(finalGames) < 1 || Number(finalGames) > 12);
  const initialOptions = (["RANDOM", "SWISS", "KING_OF_THE_HILL"] as const).map((value) => ({ value, label: ruleLabels[value] }));
  const tournamentOptions = (tournaments ?? []).map((item) => ({ value: item.id, label: item.name + (item.status === "CLOSED" ? " (ปิดอยู่)" : "") }));

  return (
    <section className="panel" id="cc">
      <div className="panel-head"><h2>สร้างการ์ดการแข่งขัน</h2></div>
      <form className="panel-body cc" onSubmit={handleSubmit(onSubmit)}>
        <div className="form-row">
          <div className="field"><span className="field__label">รายการแข่งขัน</span>
            {fixedTournament ? <strong>{fixedTournament.name}</strong> :
              <SelectMenu appearance="prototype" className="sm--block" ariaLabel="รายการแข่งขัน" value={tournamentId}
                options={tournamentOptions} onChange={setTournamentId} />}
            {!fixedTournament && !tournamentOptions.length && <span className="field-err">ยังไม่ได้รับมอบหมายรายการแข่งขัน</span>}
          </div>
          <div className="field"><label htmlFor="cf-name">ชื่อการแข่งขัน</label>
            <input className="input" id="cf-name" placeholder="เช่น A-Math Championship" {...register("name")} />
            {errors.name && <span className="field-err">{errors.name.message}</span>}
          </div>
          <div className="field"><label htmlFor="cf-division">รุ่นการแข่งขัน</label>
            <input className="input" id="cf-division" placeholder="เช่น ประถมศึกษา" {...register("division")} />
            {errors.division && <span className="field-err">{errors.division.message}</span>}
          </div>
        </div>
        <div className="form-row">
          <div className="field"><span className="field__label">จำนวนเกม</span>
            <SelectMenu appearance="prototype" className="sm--block" ariaLabel="จำนวนเกม" value={String(numberOfGames)}
              options={Array.from({ length: 11 }, (_, index) => ({ value: String(index + 2), label: `${index + 2} เกม` }))}
              onChange={(value) => setValue("numberOfGames", Number(value), { shouldValidate: true })} />
            {errors.numberOfGames && <span className="field-err">{errors.numberOfGames.message}</span>}
          </div>
          <div className="field"><span className="field__label">หมายเลขที่ประกาศให้ผู้ชม</span>
            <SelectMenu appearance="prototype" className="sm--block" ariaLabel="หมายเลขที่ประกาศให้ผู้ชม" value={slotLabel}
              options={[{ value: "PAIR", label: "คู่ที่ — ผู้ชมเห็นเลขคู่" }, { value: "SEAT", label: "ที่นั่ง — ผู้ชมเห็นเลขที่นั่ง" }]}
              onChange={(value) => setSlotLabel(value as SlotLabel)} />
          </div>
          <div className="field"><span className="field__label">กติกา Pairing เกม 1</span>
            <SelectMenu appearance="prototype" className="sm--block" ariaLabel="กติกา Pairing เกม 1" value={initialPairingRule}
              options={initialOptions} onChange={(value) => setInitialPairingRule(value as InitialPairingRule)} />
          </div>
        </div>

        <fieldset className="fs"><legend>Max diff รายเกม</legend>
          <div className="form-row form-row--tight">{gameMaxDiffs.map((value, index) => <div className="field" key={index}>
            <label htmlFor={`cf-max-diff-${index + 1}`}>เกม {index + 1}</label>
            <input className="input prototype-maxdiff num" id={`cf-max-diff-${index + 1}`} type="number" min={1} max={1_000_000}
              inputMode="numeric" required value={value} onChange={(event) => setGameMaxDiffs((current) =>
                current.map((entry, gameIndex) => gameIndex === index ? event.target.value : entry))} />
          </div>)}</div>
        </fieldset>

        <div className="form-row">
          <div className="field"><span className="field__label">รูปแบบรอบชิง</span>
            <SelectMenu appearance="prototype" className="sm--block" ariaLabel="รูปแบบรอบชิง" value={finalType}
              options={[
                { value: "NONE", label: "ไม่มีรอบชิง" }, { value: "CHAMPION", label: "ชิงที่ 1 — อันดับ 1 และ 2" },
                { value: "CHAMPION_AND_THIRD", label: "ชิงที่ 1 และ 3 — อันดับ 1–4" },
              ]} onChange={(value) => setFinalType(value as FinalType)} />
          </div>
          {finalType !== "NONE" && <div className="field">
            <label htmlFor="cf-final-games">จำนวนเกมรอบชิง</label>
            <input className="input prototype-maxdiff num" id="cf-final-games" type="number" min={1} max={12}
              required inputMode="numeric" value={finalGames} onChange={(event) => setFinalGames(event.target.value)} />
          </div>}
        </div>

        <details className="prototype-console-details"><summary>กติกาการจับคู่ระหว่างเกม</summary>
          {rules.map((rule, index) => <div className="form-row form-row--tight" key={index}>
            <span className="meta">เกม {index + 1} <ArrowRight className="i" size={12} aria-hidden /> เกม {index + 2}</span>
            <SelectMenu appearance="prototype" ariaLabel={`กติกาจากเกม ${index + 1} ไปเกม ${index + 2}`} value={rule}
              options={Object.entries(ruleLabels).map(([value, label]) => ({ value, label }))}
              onChange={(value) => setRules((current) => current.map((entry, ruleIndex) => ruleIndex === index ? value as PairingRuleType : entry))} />
          </div>)}
          <label className="checkbox-chip"><input type="checkbox" checked={gibsonEnabled} onChange={(event) => setGibsonEnabled(event.target.checked)} />เปิดใช้ Gibsonization</label>
        </details>
        <div className="form-row prototype-form-end">
          {cancelHref && <Link prefetch={false} href={cancelHref} className="btn btn--secondary">ยกเลิก</Link>}
          <button className="btn btn--primary" type="submit" disabled={isSubmitting || (!fixedTournament && !tournamentId) || invalidMaxDiffs || invalidFinal || rules.length !== numberOfGames - 1}>
            {isSubmitting ? "กำลังสร้างการ์ด…" : "สร้างการ์ด"}
          </button>
        </div>
      </form>
    </section>
  );
}
