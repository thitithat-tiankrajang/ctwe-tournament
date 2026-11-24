# Workflow ปรับ UI: แก้ prototype ก่อน แล้วยกเฉพาะส่วนที่เปลี่ยนไป React

Prototype (`~/Desktop/CTWE-prototype`) คือแบบ UI/UX ที่ตกลงกันแล้ว ส่วน React คือของจริง สองฝั่งตรงกัน ณ จุดที่บันทึกไว้ใน [`prototype-synced`](prototype-synced) (hash ของ commit ใน prototype) ทุกครั้งที่ปรับ UI ให้เทียบจากจุดนี้เท่านั้น ไม่ต้องไล่เทียบทั้งหน้าใหม่

```
แก้ prototype ──► checkpoint ──► summary/diff (จาก prototype-synced) ──► แก้ React ตาม diff ──► ตรวจ ──► synced + commit
```

## ขั้นตอน

1. **แก้ prototype** ใน `site/index.html` แก้ที่ definition ตัวสุดท้ายของ function/CSS rule นั้นตรง ๆ ได้เลย (มี git แล้ว ไม่ต้องทำ `revN.js` หรือ `splice*.py` อีก) ดูผลที่ http://127.0.0.1:4317/?role=director (หรือ `viewer`, `staff`, `admin`)
2. **Checkpoint** เมื่อพอใจ
   ```bash
   scripts/ui/proto.sh checkpoint "ย่อแถวตารางผู้เล่น"
   ```
   ทำได้หลายครั้งก่อนยกไป React แต่ละ checkpoint จะเป็น commit ใน prototype
3. **ดูว่าเปลี่ยนอะไร** เทียบกับจุดที่ React ตรงอยู่
   ```bash
   scripts/ui/proto.sh status
   ```
   ```bash
   scripts/ui/proto.sh summary
   ```
   `summary` บอกชื่อ function และ CSS rule ที่เปลี่ยน พร้อมจำนวนบรรทัด ใช้ token น้อย ถ้าต้องการรายละเอียดใช้ `scripts/ui/proto.sh diff` (หรือ `diff /tmp/proto.diff` เพื่อเขียนลงไฟล์)
4. **แก้ React** เฉพาะส่วนที่อยู่ใน diff ดูตาราง mapping ด้านล่างว่าส่วนไหนของ prototype อยู่ไฟล์ไหน
5. **ตรวจ** `npm test`, `npx tsc --noEmit -p .` และเทียบภาพ
   ```bash
   node scripts/ui/compare-shots.mjs /tmp/ctwe-ui-shots director-games
   ```
   (ต้องเปิด headless Chrome ตามที่เขียนไว้หัวไฟล์ก่อน) ได้ภาพ `-proto.png` คู่กับ `-react.png`
   หน้าที่เปิดดูที่ http://127.0.0.1:3319 เป็น production build (เร็วเท่าของจริง) แก้โค้ดแล้วต้อง build ใหม่ด้วย `scripts/ui/serve-local.sh prod` (ประมาณหนึ่งนาที ถ้า build ไม่ผ่านจะไม่หยุดตัวเดิม) ถ้ากำลังแก้ถี่ ๆ ใช้ `scripts/ui/serve-local.sh dev` ได้ แต่ทุกหน้าจะช้ากว่ามาก
6. **บันทึกจุด sync** แล้ว commit ไปพร้อมกับโค้ด React
   ```bash
   scripts/ui/proto.sh synced
   ```

ถ้า React ยกไปได้ไม่ครบ ให้ยังไม่รัน `synced` ส่วนที่ค้างจะยังโผล่ใน `summary` รอบหน้า

## อะไรแก้ที่ไหน

| เรื่อง | แก้ที่ |
| --- | --- |
| หน้าตา, layout, ข้อความ, motion, ลำดับการกด, dialog | prototype ก่อน แล้วยกไป React |
| sync/SSE, cache, auth, API, backend, การคำนวณ ranking/pairing, store | React (และ backend) โดยตรง ไม่ต้องผ่าน prototype |
| สิ่งที่ prototype จำลองไว้ (fixture, simulate toggles, localStorage ของต้นแบบ) | ไม่ยกไป React ยกเว้นตัดสินใจแล้วว่าจะทำของจริง |

## Mapping: prototype → React

| ใน prototype (`site/index.html`) | ใน React |
| --- | --- |
| `<style>` rule `.x` | `src/app/prototype-workspace.css` เป็น `.ctwe-prototype .x` (ลำดับเดียวกัน); ตัว override legacy อยู่ `prototype-shell.css`, viewer อยู่ `prototype-viewer.css`, หน้ากรอกผล `prototype-results.css` |
| `railShell`, `syncChrome`, `treeHtml`, `sideIntent`, `searchMorph`, sheet-nav | `src/ui/layout/app-shell.tsx` |
| `pgGames`, grid กรอกผล, คีย์เร็ว, สลับผู้เล่น, colfilter | `src/ui/components/result-entry-grid.tsx`, `src/app/cards/[id]/games/page.tsx`, `direct-player-swap.tsx` |
| `pgTables`, สลับผู้เล่น, Multi Switching, pairing draft | `src/app/cards/[id]/tables/page.tsx`, `direct-player-swap.tsx`, `pairing-tool.tsx`, `pairing-diff-sheet.tsx`, `pairing-ui-draft.ts` |
| `pgPlayers`, roster tools (คัดชั่วคราว/ถอน/ดึงกลับ/ลงทะเบียนเพิ่ม) | `src/app/cards/[id]/players/page.tsx`, `player-termination.tsx`, `reopen-registration.tsx`, `pairing-tool.tsx`, `roster-block-scope.tsx` |
| `operatorOverview`, `pgOverview`, `reportBlock`, `finalPanel` | `operator-round-summary.tsx`, `admin-card-overview.tsx`, `card-overview-view.tsx`, `prototype-spectator-report.tsx` |
| `auditPage`, `auditRow` | `audit-activity.tsx` |
| `pgCards` / `pgHome` / `pgDirector` / `pgAdmin` | `src/app/cards/page.tsx` / `src/app/page.tsx` / `src/app/director/page.tsx` + `card-create-form.tsx` / `src/app/admin/page.tsx` + `sport-colors-panel.tsx`, `realtime-settings-panel.tsx`, `archive-list.tsx` |
| `viewerShell`, `vHome`, `vReport`, `vRankTable`, `vPairTable`, viewer search | `tournament-viewer.tsx`, `prototype-spectator-report.tsx`, `prototype-spectator-chrome.tsx` |
| `openPlayerModal`, player popover | `prototype-spectator-player.tsx` |
| `selectMenu`/`openSelect`, combobox, `openDialog`, `numField`, `help()` | `select-menu.tsx`, `institution-combobox.tsx`, `confirm-dialog.tsx`/`prompt-dialog.tsx`, class `.nf`, `PrototypeViewerHelp` |

ถ้าเจอว่า mapping ผิดหรือขาด ให้แก้ตารางนี้ด้วย รอบหน้าจะได้ไม่ต้องค้นใหม่

## ความต่างที่รู้แล้วและตั้งใจคงไว้

- คัดชั่วคราว: React ขอรหัสผ่านก่อนเปิดเครื่องมือ เพราะเปิด pairing session ฝั่ง server (prototype ขอตอน review)
- รหัสนำหน้าการ์ด (A, B…) ในรายการการ์ดแสดงเฉพาะการ์ดที่โหลดเต็มแล้ว เพราะ card summary ไม่มี field นี้
- Viewer แสดงผลที่บันทึกแล้วแบบสด ก่อนประกาศผลทางการ (พฤติกรรมเดิมของระบบจริง)
