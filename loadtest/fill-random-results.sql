-- ============================================================================
-- Load-test helper: กรอกผล "สุ่ม 250–750" ให้ทุกคู่ของเกมที่เลือก (กดรันทีเดียว)
--
-- ใช้เมื่อ: setup ครบผ่าน UI แล้ว (สร้าง tour/card/player, ยืนยัน pairing เกมนั้น
--          จนการ์ดอยู่สถานะ "กรอกผล" — RESULT_COLLECTION) แต่ไม่อยากกรอกมือทีละคู่
--
-- สคริปต์นี้เขียนลงตาราง matches เท่านั้น (7 คอลัมน์เหมือนที่ระบบเขียนตอนกรอกมือ)
-- standings / ranking จะถูกคำนวณใหม่ทั้งหมดตอนคุณกด Publish ผ่าน UI — ไม่ต้องแตะที่นี่
--
-- รองรับ: KING_OF_THE_HILL / SWISS / RANDOM / MANUAL (เกมปกติ)
-- ไม่รองรับ: เกมต้นทางของ PAIR_RESULT (แพ้เจอแพ้ชนะเจอชนะ) — เพราะการเติมผลต้นทาง
--            ต้องให้ระบบ materialize คู่ปลายทางให้ ต้องกรอกผ่าน UI เท่านั้น
-- ============================================================================

-- ┌── แก้ 2 บรรทัดนี้ให้ตรงกับการ์ด/เกมที่ต้องการ ───────────────────────────┐
\set cid  '00000000-0000-0000-0000-000000000000'   -- card_id (ดูได้จาก URL /cards/<id>/games หรือ query ท้ายไฟล์)
\set game 1                                          -- เลขเกมที่จะกรอกผล
-- └──────────────────────────────────────────────────────────────────────────┘

\echo '>>> กำลังกรอกผลสุ่ม 250–750 ให้เกม' :game 'ของการ์ด' :'cid'

UPDATE matches AS m
SET score_one       = r.s1,
    score_two       = r.s2,
    -- คู่ปกติ: คนคะแนนสูงกว่าเป็นผู้ชนะ (เท่ากัน = เสมอ, winner NULL)
    -- คู่บาย (อีกฝั่ง NULL): คนที่อยู่ได้คะแนนสุ่ม อีกฝั่งเป็น 0 → ชนะเสมอ
    winner          = CASE
                        WHEN r.s1 > r.s2 THEN m.player_one
                        WHEN r.s2 > r.s1 THEN m.player_two
                        ELSE NULL
                      END,
    result_type     = CASE WHEN r.s1 = r.s2 THEN 'D' ELSE 'W' END,
    calculated_diff = LEAST(ABS(r.s1 - r.s2), g.max_diff),   -- cap ด้วย max_diff ของเกม เหมือน UI
    submitted_by    = 'loadtest-sql',
    submitted_at    = now()
FROM games AS g,
     LATERAL (
       SELECT
         CASE WHEN m.player_one IS NULL THEN 0 ELSE (250 + floor(random() * 501))::int END AS s1,
         CASE WHEN m.player_two IS NULL THEN 0 ELSE (250 + floor(random() * 501))::int END AS s2
     ) AS r
WHERE g.card_id     = m.card_id
  AND g.game_number = m.game_number
  AND m.card_id     = :'cid'
  AND m.game_number = :game
  AND m.snapshot_no IS NULL                                  -- เฉพาะเกมที่ยังไม่ publish
  AND m.result_type IS NULL                                  -- ข้ามคู่ที่กรอกไปแล้ว (รันซ้ำได้ไม่ทับของเดิม)
  AND (m.player_one IS NOT NULL OR m.player_two IS NOT NULL); -- ข้ามคู่ปลายทาง PAIR_RESULT ที่ยังไม่มีผู้เล่น

-- สรุปหลังรัน: กรอกแล้ว / ค้าง / เสมอ กี่คู่
SELECT
  COUNT(*)                                        AS total_pairs,
  COUNT(*) FILTER (WHERE result_type IS NOT NULL) AS filled,
  COUNT(*) FILTER (WHERE result_type IS NULL
                     AND (player_one IS NOT NULL OR player_two IS NOT NULL)) AS still_pending,
  COUNT(*) FILTER (WHERE result_type = 'D')       AS draws,
  COUNT(*) FILTER (WHERE player_one IS NULL OR player_two IS NULL) AS byes
FROM matches
WHERE card_id = :'cid' AND game_number = :game AND snapshot_no IS NULL;

-- ============================================================================
-- ไม่รู้ card_id? รันเฉพาะบล็อกนี้เพื่อดูการ์ดที่กำลังกรอกผล + เกมปัจจุบัน:
--
--   SELECT c.id AS card_id, c.name, c.current_game, c.runtime_stage,
--          (SELECT COUNT(*) FROM matches m
--             WHERE m.card_id = c.id AND m.game_number = c.current_game
--               AND m.snapshot_no IS NULL AND m.result_type IS NULL) AS pending_current_game
--   FROM tournament_cards c
--   WHERE c.runtime_stage = 'RESULT_COLLECTION'
--   ORDER BY c.name;
-- ============================================================================
