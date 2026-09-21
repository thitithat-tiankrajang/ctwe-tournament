import type { SpectatorPlayerView } from "@/application/tournament/spectator-player";

const signed = (value: number) => `${value > 0 ? "+" : ""}${value}`;
const metric = (value: number) => Number.isInteger(value) ? `${value}` : value.toFixed(1);

/** A dedicated shareable record. It consumes the completed projection and performs no ranking. */
export function SpectatorMemoryCard({ tournamentName, competitionName, view }: {
  tournamentName: string;
  competitionName: string;
  view: SpectatorPlayerView;
}) {
  const record = view.completedRecord;
  if (!record) return null;
  const scope = record.statsScope === "qualifying" ? "รอบคัดเลือก" : "การแข่งขัน";
  return (
    <article className="spectator-memory" aria-label="บันทึกผลงานการแข่งขันอย่างเป็นทางการ"
      data-memory-record="true">
      <header className="spectator-memory__masthead">
        <div className="spectator-memory__brand" aria-label="CTWE Tournament">
          <strong>CTWE</strong><span>PLAYER RECORD</span>
        </div>
        <div className="spectator-memory__competition">
          <strong>{competitionName}</strong>
          <span>{view.divisionLabel}</span>
        </div>
        <span className="spectator-memory__official">ผลอย่างเป็นทางการ</span>
      </header>

      <div className="spectator-memory__subject">
        <section className="spectator-memory__identity" aria-label="ข้อมูลนักกีฬา">
          <p className="spectator-memory__code"><span>นักกีฬา</span><strong>{view.participant.code}</strong></p>
          <h1>{view.participant.name}</h1>
          <p className="spectator-memory__school">{view.participant.school || "—"}</p>
          {tournamentName.trim() !== competitionName.trim()
            && <p className="spectator-memory__tournament"><span>รายการ</span>{tournamentName}</p>}
        </section>
        <section className="spectator-memory__placing" aria-label={`อันดับสุดท้าย ${record.placing}`}>
          <span>อันดับสุดท้าย</span>
          <strong><small>#</small>{record.placing}</strong>
          <p>{record.statsScope === "qualifying" ? "จากผลรอบชิง" : "ของการแข่งขัน"}</p>
        </section>
      </div>

      <dl className="spectator-memory__performance" aria-label={`สถิติ${scope}`}>
        <div className="spectator-memory__metric spectator-memory__metric--average">
          <dt>คะแนนเฉลี่ย</dt><dd>{metric(record.averageScore)}</dd><small>{scope}</small>
        </div>
        <div className="spectator-memory__metric spectator-memory__metric--rate">
          <dt>อัตราชนะ</dt><dd>{metric(record.winRate)}<small>%</small></dd><small>จากผล W/T/L</small>
        </div>
        <div className="spectator-memory__metric spectator-memory__metric--record">
          <dt>ชนะ · เสมอ · แพ้</dt>
          <dd><span>{record.wins}</span><i>/</i><span>{record.draws}</span><i>/</i><span>{record.losses}</span></dd>
          <small>W / T / L</small>
        </div>
        <div className="spectator-memory__metric spectator-memory__metric--diff">
          <dt>ผลต่างสะสม</dt>
          <dd className={record.diff > 0 ? "is-positive" : record.diff < 0 ? "is-negative" : ""}>{signed(record.diff)}</dd>
          <small>คะแนน</small>
        </div>
      </dl>
    </article>
  );
}
