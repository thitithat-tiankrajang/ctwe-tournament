# Design Audit — UI / UX ทุกหน้า แยกตาม Role

> เอกสารนี้เกิดจากการไล่อ่านทุก page + component ใน `src/app` และ `src/ui`
> จุดประสงค์: ให้เจ้าของโปรเจกต์ validate ว่าข้อไหนควรทำ (ทุกข้อมีรหัส เช่น `UI-R1` ไว้อ้างอิง)

## สถานะการทำ (อัปเดต 15 ก.ค. 2026)

**ทำแล้ว (validate รอบ 1):** UI-R1–R10, UI-F1, UI-F2, UI-F6, UI-F7, UI-F8, UI-F11, UI-A1, UI-A2, UI-A3, UX-F1, UX-F2, UX-F4, UX-A3, UX-A5
**ทำแล้ว (validate รอบ 2):** UI-F3, UI-F4, UI-F5, UI-F9, UI-F10, UI-F12, UI-F13, UI-A4, UX-F5, UX-F6, UX-F7, UX-F8, UX-F9, UX-R2, Section 4 ทั้งหมด
**ยังไม่ทำ (ยังไม่ถูก validate):** UX-F3 (segmented multi-select), UX-R1 (double-tap ranking), UX-R3 (พับฟอร์มสลับคู่หน้า tables), UX-A1 (จำรหัสของฉัน), UX-A2 (สถานะ SSE), UX-A4, UI-A5

หมายเหตุ implementation ที่ต่างจากข้อเสนอเดิม:
- UI-F5: ใช้ `console-section` (heading + hint แบบมี CSS class) แทนการห่อ Panel เพราะ CardCreateForm มี Panel ของตัวเองอยู่แล้ว (Panel ซ้อน Panel จะผิดโครงสร้าง)
- UI-F9: ขยาย `ConfirmDialog` (children/icon/eyebrow/className/busyLabel) และ `PromptDialog` (danger/eyebrow) แล้ว migrate dialog เขียนมือทั้ง 6 จุด (games×2, reopen-registration, player-termination, override-editor, app-shell logout + notification consent)
- UI-F12: ตาราง audit ใช้ DataGrid แล้ว `table-search.tsx` ไม่มีผู้ใช้ → ลบไฟล์ + CSS ทิ้ง
- UX-R2+UX-F5: ตัดโหมด hover ออก เหลือปุ่มหุบ/ขยาย (PanelLeftClose/Open) เมนูชุดเดียว เรนเดอร์ตามสถานะ

> บริบทสำคัญ:
> - **Viewer (public)** เข้าจาก **มือถือ** เป็นหลัก ผ่าน `/tour/{slug}` (และ `/t/{token}` legacy)
> - **Staff / Director / Admin** เข้าจาก **คอมพิวเตอร์** เป็นหลัก
> - Role model: `roles.ts` — Admin = platform watcher (ดูได้ทุก tournament แต่ไม่แก้การ์ด), Director = จัดการการ์ด/pairing/publish, Staff = กรอกผลอย่างเดียว

---

## 1. แผนที่หน้าทั้งหมด × Role

| Route | Viewer | Staff | Director | Admin | หมายเหตุ |
|---|---|---|---|---|---|
| `/` | login gate | auto-redirect เข้า tournament ตัวเอง | รายการ tournament ที่ดูแล (จัดการ) | ทุก tournament (เข้าชม) + ปุ่มคอนโซล | ที่เดียวที่มีปุ่ม login |
| `/staff-login` | ✔ (ฟอร์ม login) | ✔ | ✔ | ✔ | |
| `/tour/{slug}`, `/t/{token}` | ✔ หน้าหลักของ viewer | (ใช้ได้) | (ใช้ได้) | (ใช้ได้) | bundle เดียว + hash switch |
| `/cards` | — (ถูกไล่กลับ `/`) | ✔ list การ์ด | ✔ list + สร้าง/ลบ | ✔ list (อ่านอย่างเดียว) | |
| `/cards/create` | ✖ | ✖ | redirect ไป `/director` | ✖ | เหลือใช้กรณี admin+director เท่านั้น (แทบตาย) |
| `/cards/[id]` (overview) | ✔ (ผ่าน viewer) | ✔ | ✔ + workflow notice + ปิดการ์ด | ✔ | คอมโพเนนต์เดียวกับ viewer |
| `/cards/[id]/players` | ✖ | ✔ read-only | ✔ แก้ไข/เพิ่ม/ลบ/terminate | ✖ (โดน guard "เจ้าหน้าที่เท่านั้น" → เห็น EmptyState) | |
| `/cards/[id]/tables` | ✖ | ✖ (director only) | ✔ pairing/สลับ/ยืนยัน | ✖ | |
| `/cards/[id]/games` | ✖ | ✔ กรอกผล | ✔ กรอก + review + publish + ลงดาบ + แก้ย้อนหลัง | ✖ | หน้าใหญ่สุด |
| `/cards/[id]/audit` | ✖ | ✖ | ✔ + PDF download | ✔ | |
| `/admin` | ✖ | ✖ | ✖ | ✔ | inline style เยอะมาก |
| `/director` | ✖ | ✖ | ✔ (staff mgmt + สร้างการ์ด) | ✖ | |
| `/dev-tools` | ✖ | ✖ | ✖ | ✔ | ข้อความ guard/badge ไม่ตรง role จริง |
| `/tournaments` | redirect `/admin` | | | | dead route |
| `/cards/[id]/standings` | redirect `/players` | | | | dead route |

---

## 2. Audit รายหน้า (สิ่งที่แสดง + ปัญหาที่เจอ)

### 2.1 `/` — Home (`src/app/page.tsx`)
**แสดง:** login gate (anonymous) / รายการ tournament (director/admin) / คลัง Excel archive
**ปัญหา:**
- Badge สถานะ tournament "เปิด/ปิด" จริง ๆ หมายถึง *สถานะลิงก์เข้าชม* ไม่ใช่สถานะการแข่งขัน — director อาจเข้าใจผิดว่าการแข่งจบแล้ว → ควรใช้คำว่า "ลิงก์เปิด / ลิงก์ปิด"
- footer การ์ด (director) เขียนว่า "รายการที่คุณดูแล" ซ้ำกับหัว Panel ("รายการแข่งขันที่คุณดูแล") — ข้อมูลซ้ำไม่มีประโยชน์
- คลัง archive โผล่ให้ director ด้วยทั้งที่โหลดจาก public archives — สมเหตุสมผล แต่ควรอยู่ล่างสุดเสมอ (ตอนนี้ถูกแล้ว) ✓

### 2.2 `/staff-login` (`src/app/staff-login/page.tsx`)
**ปัญหา:**
- ข้อความ "ต้อง login ก่อนถึงจะดูได้" ปรากฏ **3 ครั้ง** ในหน้าเดียว (PageHeader description + Panel description + notice--info) — ซ้ำซ้อน
- Panel description โชว์ศัพท์นักพัฒนา: "server-side session, CSRF protection, browser storage" — ผู้ใช้ทั่วไปไม่ต้องรู้
- หัว Panel เป็นภาษาอังกฤษ "Staff authentication" ทั้งที่ทั้งระบบเป็นไทย

### 2.3 `/cards` — Card list (`src/app/cards/page.tsx`)
**แสดง:** การ์ดจัดกลุ่มตามชื่อ → แถวละ (ชื่อการ์ด + รุ่น + ลูกศร) + ปุ่มลบ (director)
**ปัญหา:**
- แถวการ์ดแสดง `card.name` ซ้ำกับหัวกลุ่ม (`card-group__title` ก็คือ name เดียวกัน) — ทุกแถวในกลุ่มพิมพ์ชื่อเดิมซ้ำ
- **ไม่มีข้อมูลสถานะการ์ดเลย** — director ที่มีหลายรุ่นไม่รู้ว่าการ์ดไหนอยู่ขั้นไหน (ลงทะเบียน? เกม 3/7? จบแล้ว?) ต้องคลิกเข้าไปดูทีละใบ
- EmptyState ตอน `needsTournament` มีปุ่ม "ไปคอนโซลผู้ดูแล" → `/admin` — แต่คนที่เจอ state นี้คือ staff/director ซึ่ง**เข้า /admin ไม่ได้** (จะเจอหน้า "สำหรับผู้ดูแลระบบเท่านั้น")

### 2.4 `/cards/[id]` — Card overview (`card-overview.tsx`) — หน้าเดียวกับ viewer
**แสดง:** header (ชื่อ+รุ่น, ตัวกรองนักกีฬา/โรงเรียน, เลือกเกม, view picker) + Ranking/Pairing/Result + history dialog + final board
**ปัญหา:**
- ตัวหนังสือ "X จาก Y เกมเผยแพร่ผลแล้ว" ใต้ตัวเลือกเกมมี `font-size: clamp(7px, .35vw+6px, 9px)` และ 6.5px บนจอเล็ก — **เล็กเกินอ่าน / ไม่ผ่าน accessibility**
- Empty state ตอนยังไม่เลือก view: "กดปุ่ม Ranking / Pairing / Result **ด้านล่าง**" — บน desktop ปุ่มอยู่**ด้านบน** (ใน header); คำว่า "ด้านล่าง" ถูกเฉพาะ mobile
- Interaction ตาราง Ranking: แตะครั้งแรก = เลือกแถว, แตะซ้ำ = เปิดประวัติ — **pattern ซ่อนอยู่ ไม่มี affordance บอก** โดยเฉพาะบนมือถือ (double-tap ไม่มีใครเดาได้)
- View picker เป็น segmented control แต่เลือกได้หลายอันพร้อมกัน (multi-select) — ขัด mental model ของ segmented (ปกติ = เลือกอันเดียว); บน desktop เปิด 3 ตารางพร้อมกันได้ผลลัพธ์ยาวมาก
- `overview-view-section` เป็น div ครอบ Panel ชั้นเดียวเพื่อถือ ref สำหรับ scrollIntoView; `overview-ranking-table` ครอบ DataGrid ชั้นเดียวเพื่อใช้ closest() — **div ซ้อน div ลูกเดียว 2 จุด** แก้ได้โดยให้ Panel รับ ref/className
- viewer ไม่เห็น "เผยแพร่เมื่อ (เวลา)" ของเกมที่กำลังดู — ไม่รู้ว่าข้อมูลสดแค่ไหน (ข้อมูล `confirmedAt` มีอยู่แล้วใน snapshot)

### 2.5 `/cards/[id]/players` (`players/page.tsx`)
**แสดง:** ฟอร์มเพิ่มผู้เล่น + Excel import + terminate/restore + ranking panel + ตารางผู้เล่น
**ปัญหา:**
- Eyebrow แสดง **enum ดิบ**: `PLAYER_REGISTRATION`, `RESULT_COLLECTION` ฯลฯ — มี `stageLabels` ภาษาไทยอยู่แล้วใน card-overview แต่ไม่ได้ใช้ที่นี่
- ตารางผู้เล่นช่วง**ลงทะเบียน**มีคอลัมน์ WP / ชนะ / เสมอ / แพ้ / Difference ที่เป็น **0 ทั้งหมดทุกแถว** — ข้อมูลไร้ความหมายในขั้นตอนนั้น กินที่จอ
- คำอธิบายฟอร์ม: "backend จะเป็นผู้ยืนยันรหัสจริงเพื่อป้องกันข้อมูลชนกัน" — ศัพท์นักพัฒนา ("backend") โผล่ให้ director อ่าน
- Panel "Ranking หลังจบแต่ละเกม" มีแค่ GameFlow + แถบสรุป แต่**ตารางจริงอยู่คนละก้อนด้านล่าง** (ตารางแก้ไขของ director) — ความเชื่อมโยงระหว่างตัวเลือกเกมกับตารางไม่ชัด
- ปุ่มลบผู้เล่นบอกว่าจะ "เลื่อนรหัสของผู้เล่นถัดไป N คน" ใน dialog — ดี ✓ แต่การ *เลื่อนรหัส* หลังลบเป็นพฤติกรรมที่ควรโชว์เตือนบนหน้าด้วยเมื่อ import เสร็จแล้วมีการลบ

### 2.6 `/cards/[id]/tables` (`tables/page.tsx`) — Director only
**ปัญหา:**
- Eyebrow แสดง enum ดิบเหมือนกัน (`TABLE_PAIRING` ฯลฯ)
- EmptyState: "Pairing และอันดับแต่ละเกมจะปรากฏที่นี่หลัง**เจ้าหน้าที่** Publish ผล" — จริง ๆ คนที่ Publish คือ**ผู้อำนวยการ** (ปนคำเรียก role ทำให้สับสน; มีอีกหลายจุดทั่วแอป)
- ฟอร์มสลับคู่ (สอง combobox + password) แสดงตลอดตอน preview แม้ผู้ใช้ส่วนใหญ่ไม่ได้สลับ — กินพื้นที่เหนือ Pairing preview ซึ่งเป็นข้อมูลหลักของหน้า (ควรพับได้/ย้ายลง)

### 2.7 `/cards/[id]/games` (`games/page.tsx`) — หน้าใหญ่สุด
**ปัญหา:**
- Eyebrow enum ดิบใน state ที่ไม่ใช่ collection (`${card.runtimeStage}`)
- **Staff ที่กรอกผลครบแล้วไม่รู้ว่าต้องทำอะไรต่อ** — ปุ่ม "Review ผล" เป็นของ director เท่านั้น; ฝั่ง staff ไม่มีข้อความบอกว่า "ครบแล้ว รอผู้อำนวยการ Review" (จอเงียบเฉย)
- มี dialog เขียนเองกับมือ 2 ชุดในหน้านี้ (ยืนยันรหัสผ่านแก้ย้อนหลัง + ลงดาบ) ทั้งที่มี `PromptDialog` / `ConfirmDialog` กลางอยู่แล้ว — โค้ดซ้ำ ~70 บรรทัด และหน้าตา/behavior เพี้ยนจาก dialog กลางได้ง่าย
- ภาษาปนไทย/อังกฤษไม่คงเส้น: "Finish & Publish", "Review ผล", "กรอกผล Game 3" vs "เกม 3" — ทั้งแอปสลับ "Game"/"เกม" ไปมา
- `FinalRoundBoard` หัวตาราง: `fill-diff`, `save` — ภาษาอังกฤษ lowercase หลุดมาจาก dev
- แถบ director-game-toolbar (เลือกดูเกมย้อนหลัง) โผล่เฉพาะ resultCollection — ดี ✓ แต่ note "กำลังดูเกมย้อนหลัง" ควรเด่นกว่านี้เพราะกำลังจะแก้ข้อมูลที่เผยแพร่แล้ว

### 2.8 `/cards/[id]/audit` (`audit/page.tsx`)
**ปัญหา:**
- Panel "ดาวน์โหลดเอกสาร PDF" อยู่บนหน้า "บันทึกกิจกรรม" — เอกสาร Pairing/Ranking/Result ไม่ใช่ audit; ตำแหน่งผิดหมวด (director หา PDF จะไม่คิดว่าอยู่ใต้ "บันทึกกิจกรรม")
- ตาราง audit ใช้ `SearchableTable` (ตารางเก่า ไม่มี sort/resize) ขณะที่ตารางอื่นเป็น DataGrid — สองระบบตาราง

### 2.9 `/admin` (`admin/page.tsx`)
**ปัญหา:**
- **Inline style ~25 จุด** (`style={{display:"flex", gap:10,...}}`) แทน CSS class — หน้าตาไม่คงเส้นกับส่วนอื่น แก้ยาก
- ใช้ class `notice` (ที่ออกแบบมาเป็นกล่องแจ้งเตือน) เป็น**การ์ด list item** ของ tournament/director — semantic ผิด ถ้าแก้สไตล์ notice จะพังหน้านี้
- ปุ่ม "เก็บเข้าคลัง" (archive = **ลบข้อมูลทั้งหมดออกจาก DB ถาวร**) เป็น `variant="secondary"` วางติดกับปุ่มปิดลิงก์ธรรมดา — destructive action ไม่มี visual distinction
- `RealtimeSettingsPanel` (จูน SSE infra) แทรกอยู่**กลางหน้า**ระหว่าง Tournaments กับ Archive — คนละหมวดกับ content ควรอยู่ล่างสุด
- ใน RealtimeSettingsPanel: state form มี `pollingEnabled` + `pollingIntervalMs` แต่**ไม่มี input ให้แก้** — ของตกค้าง

### 2.10 `/director` (`director/page.tsx`)
**ปัญหา:**
- Section "สร้างการ์ดการแข่งขัน" ใช้ `<div><h2><p>` เปล่า ๆ แทน `Panel`/`PageHeader` — โครงสร้างหลุดจากหน้าอื่นทั้งแอป
- เมนู sidebar เรียกหน้านี้ว่า "จัดการเจ้าหน้าที่" แต่ในหน้ามีทั้งจัดการ staff **และ**สร้างการ์ด — ชื่อเมนูไม่ครอบงาน (director ที่จะสร้างการ์ดไม่รู้ต้องมาหน้านี้)
- Panel "เจ้าหน้าที่ของคุณ" ส่ง `description=""` (string ว่าง) — เศษโค้ด
- inline style หนักเหมือน /admin

### 2.11 `/dev-tools` (`dev-tools/page.tsx`)
**ปัญหา:**
- Badge: `POSTGRESQL · STAFF ONLY` — จริง ๆ คือ **admin only**; guard message ก็เขียน "สำหรับเจ้าหน้าที่เท่านั้น" — ข้อความไม่ตรงสิทธิ์จริง (คน role staff เข้ามาเจอข้อความเหมือนตัวเองควรเข้าได้)

### 2.12 `/tour/{slug}` — Tournament viewer (`tournament-viewer.tsx`) — มือถือเป็นหลัก
**ปัญหา:**
- ปุ่มย้อนกลับมี **2 element ซ้ำกันใน DOM** (`tour-mobile-card-back` + `tour-back-link`) สลับโชว์ด้วย CSS media query — ควรเป็น element เดียวแล้วปรับสไตล์ตาม breakpoint
- ลิงก์ตาย (`dead`): ปุ่ม "ไปหน้ารวมการแข่งขัน" ชี้ไป `/` — แต่ viewer ที่ไม่ได้ login จะเจอ**หน้าบังคับ login** ไม่ใช่หน้ารวมอะไรทั้งนั้น — CTA หลอก
- แถวการ์ดโชว์ชื่อซ้ำหัวกลุ่ม (ปัญหาเดียวกับ /cards)

### 2.13 `app-shell.tsx` (sidebar / mobile chrome)
**ปัญหา:**
- Sidebar render เมนู **2 ชุดเต็ม ๆ** (rail แบบย่อ + expanded) พร้อมกันตลอด สลับด้วย CSS — DOM ซ้ำและ aria ต้องคอย hide ทีละชั้น; ใช้ชุดเดียว + CSS collapse ได้
- ปุ่ม lock/unlock sidebar (โหมด hover-to-expand) เป็น power feature ที่อธิบายผ่าน title ยาว ๆ — ผู้ใช้ทั่วไปกดสลับแล้วงงว่าเมนูหายไปไหน
- role footer ของ viewer: "Public viewer · ดูข้อมูลเท่านั้น" — ภาษาอังกฤษปนไทย

### 2.14 Component กลาง
- **`DataGrid` (`data-grid.tsx`) รับ props `resetKey`, `unit`, `pageSize` แต่ไม่ได้ใช้เลย** — callers หลายที่ส่ง `resetKey={String(selectedGame)}` โดยตั้งใจให้ filter/sort รีเซ็ตเมื่อเปลี่ยนเกม → **ของจริงคือ filter ค้างข้ามเกม** (ผู้ใช้เปลี่ยนเกมแล้วยังโดนตัวกรองเก่ากรองอยู่ เห็นข้อมูลไม่ครบโดยไม่รู้ตัว — มี chips บอกแต่เล็ก) — เป็น bug จริง
- `DataGrid` **เขียน header/filter logic ซ้ำกับ `GridHead`+`useColumnControls`** (~120 บรรทัด duplicate) — สอง implementation ของ Excel header ใน file เดียว
- `ResultViewGrid`: `entry-grid-wrap > entry-grid-scroll` — wrap มีลูกเดียว (ไม่มี meta bar) → div ซ้อนเปล่า
- `Stat` component ใน `page.tsx` — **ไม่มีใครใช้** (dead code)
- `Badge` เดา tone จากข้อความ children (`statusTone[String(children)]`) — magic behavior ที่พังเงียบ ๆ ถ้าข้อความเปลี่ยน
- `FreshSecretInput` ไม่มีปุ่ม show/hide รหัสผ่าน — พิมพ์รหัสยาวผิดแล้วต้องลบพิมพ์ใหม่ทั้งหมด (มีจุดใช้ ~10 ที่)

---

## 3. รายการให้ validate

> ✅ = แนะนำให้ทำ (impact สูง / เสี่ยงต่ำ) · ⚠️ = ควรคุยก่อน (มี trade-off)

### 3.1 UI — ควร "เอาออก" (Remove)

| รหัส | รายการ | ที่มา | คำแนะนำ |
|---|---|---|---|
| UI-R1 | คอลัมน์ WP/ชนะ/เสมอ/แพ้/Diff ในตารางผู้เล่น **ช่วงลงทะเบียน** (ค่า 0 ล้วน) | players/page.tsx | ✅ ซ่อนช่วง `PLAYER_REGISTRATION` เหลือ #, รหัส, ชื่อ, สถาบัน, จัดการ |
| UI-R2 | ข้อความ login ซ้ำ 3 จุดใน `/staff-login` | staff-login | ✅ เหลือจุดเดียว (ใน Panel) |
| UI-R3 | ศัพท์นักพัฒนาที่โผล่หา user: "backend", "CSRF/session", badge "POSTGRESQL · STAFF ONLY" | players, staff-login, dev-tools | ✅ ลบ/เขียนใหม่เป็นภาษาผู้ใช้ |
| UI-R4 | ชื่อการ์ดซ้ำในแถว (หัวกลุ่ม = ชื่อเดียวกัน) | cards, tournament-viewer | ✅ แถวแสดงเฉพาะ division (ตัวใหญ่ขึ้น) |
| UI-R5 | ปุ่มย้อนกลับ 2 element ซ้ำใน viewer | tournament-viewer | ✅ ยุบเหลือ element เดียว + responsive CSS |
| UI-R6 | `Stat` component (dead code) + props `resetKey`/`unit`/`pageSize` ที่ DataGrid ไม่ใช้ | page.tsx, data-grid | ✅ ลบ Stat; ส่วน `resetKey` ดู UX-F1 (ควร implement ไม่ใช่ลบ) |
| UI-R7 | `pollingEnabled`/`pollingIntervalMs` ตกค้างใน RealtimeSettingsPanel state | realtime-settings-panel | ✅ ลบออกจาก form state |
| UI-R8 | `description=""` ของ Panel "เจ้าหน้าที่ของคุณ" | director | ✅ ลบ prop หรือใส่ข้อความจริง |
| UI-R9 | CTA "ไปหน้ารวมการแข่งขัน" บนหน้า dead link ของ viewer (พาไปเจอ login gate) | tournament-viewer | ✅ เอาปุ่มออก เหลือข้อความติดต่อผู้จัด |
| UI-R10 | ปุ่ม "ไปคอนโซลผู้ดูแล" ใน EmptyState ของ /cards (staff/director เข้า /admin ไม่ได้) | cards | ✅ เอาออก หรือเปลี่ยนเป็นลิงก์ "/" |

### 3.2 UI — ควร "แก้ไข" (Fix)

| รหัส | รายการ | ที่มา | คำแนะนำ |
|---|---|---|---|
| UI-F1 | Eyebrow แสดง enum ดิบ (`PLAYER_REGISTRATION`, `RESULT_COLLECTION`, …) 3 หน้า | players, tables, games | ✅ export `stageLabels` จาก card-overview (หรือย้ายเข้า domain) แล้วใช้ทุกหน้า |
| UI-F2 | ตัวหนังสือ "X จาก Y เกมเผยแพร่ผลแล้ว" เล็ก 6.5–9px | card-overview + globals.css | ✅ ขั้นต่ำ 11–12px หรือย้ายไปเป็นบรรทัดใน SelectMenu |
| UI-F3 | ปุ่ม "เก็บเข้าคลัง" (ลบข้อมูลถาวร) เป็น secondary ธรรมดา | admin | ✅ เปลี่ยนเป็น danger/แยกโซน |
| UI-F4 | Inline styles ~25 จุดใน /admin + /director → ย้ายเป็น CSS class (`admin-row`, `chip-list`, …) และเลิกใช้ `notice` เป็น list card | admin, director | ✅ |
| UI-F5 | Section สร้างการ์ดใน /director ใช้ div+h2 เปล่า | director | ✅ ห่อด้วย Panel ให้เหมือนส่วนอื่น |
| UI-F6 | ภาษา "Game"/"เกม", "Finish & Publish", "fill-diff", "save", "complete" ปนกันทั้งแอป | games, final-round-board, card-overview | ✅ กำหนดมาตรฐาน: UI ไทยทั้งหมด ยกเว้นคำเทคนิคที่ทีมใช้จริง (Pairing, Publish, Ranking) |
| UI-F7 | ข้อความ empty state "กดปุ่ม … ด้านล่าง" ผิดตำแหน่งบน desktop | card-overview | ✅ เปลี่ยนเป็นคำกลาง ("เลือกมุมมอง Ranking / Pairing / Result เพื่อแสดงข้อมูล") |
| UI-F8 | Badge "เปิด/ปิด" ของ tournament หมายถึงลิงก์ ไม่ใช่การแข่งขัน | home, admin | ✅ เปลี่ยนเป็น "ลิงก์เปิด / ลิงก์ปิด" |
| UI-F9 | dialog เขียนเอง 2 ชุดในหน้า games (password + ลงดาบ) | games | ✅ เปลี่ยนไปใช้ PromptDialog + form ใน dialog กลาง (ลดโค้ด ~70 บรรทัด) |
| UI-F10 | DataGrid มี header/filter logic ซ้ำกับ GridHead/useColumnControls | data-grid | ✅ ให้ DataGrid ใช้ GridHead + useColumnControls (ลด ~120 บรรทัด) |
| UI-F11 | คำเรียก role ปนกัน ("เจ้าหน้าที่" ใช้เรียกทั้ง staff และ director) | tables, card-overview, หลายจุด | ✅ นิยาม: staff = "เจ้าหน้าที่กรอกผล", director = "ผู้อำนวยการ" แล้วไล่แก้ข้อความ |
| UI-F12 | ตาราง audit ใช้ SearchableTable (คนละระบบกับ DataGrid) | audit | ⚠️ ถ้าอยาก unify ค่อยทำ — งานใหญ่ ผลตอบแทนปานกลาง |
| UI-F13 | Badge เดา tone จากเนื้อความ children | badge.tsx | ⚠️ บังคับส่ง tone ชัด ๆ ทุกจุด (ปลอดภัยขึ้น แต่ต้องไล่แก้ผู้เรียก) |

### 3.3 UI — ควร "เพิ่ม" (Add)

| รหัส | รายการ | ที่มา | คำแนะนำ |
|---|---|---|---|
| UI-A1 | **Stage/progress badge บนแถวการ์ด** ใน /cards และ viewer เช่น "ลงทะเบียน · 32 คน", "เกม 3/7 · กรอกผล", "จบแล้ว" | cards, tournament-viewer | ✅ impact สูงสุดสำหรับ director หลายรุ่น + viewer เลือกดูรุ่นที่กำลังแข่ง |
| UI-A2 | เวลาเผยแพร่ล่าสุดของเกมที่ดูอยู่ ("เผยแพร่เมื่อ 14:32") ใน overview | card-overview | ✅ ใช้ `snapshot.confirmedAt` ที่มีอยู่แล้ว |
| UI-A3 | ปุ่ม show/hide รหัสผ่านใน FreshSecretInput | fresh-secret-input | ✅ ใช้ ~10 จุดทั่วแอป |
| UI-A4 | ลิงก์ "เปิดหน้า viewer" (แท็บใหม่) ข้างปุ่มคัดลอกลิงก์ใน /admin | admin | ✅ เล็ก แต่ admin ได้เช็คของจริงทันที |
| UI-A5 | ตัวเลขความคืบหน้ารวมใน header หน้า games ("กรอกแล้ว 41/48 คู่") | games | ⚠️ มี badge ต่อ panel อยู่แล้ว — เพิ่มเฉพาะกรณี PAIR_RESULT ที่มี 2 ตาราง |

### 3.4 UX — ควร "เอาออก" (Remove)

| รหัส | รายการ | ที่มา | คำแนะนำ |
|---|---|---|---|
| UX-R1 | double-tap แถว Ranking เพื่อเปิดประวัติ (แตะ 1 = เลือก, แตะ 2 = เปิด) | card-overview | ✅ มือถือ: แตะครั้งเดียวเปิดประวัติเลย (การ "เลือกแถว" ไม่มีประโยชน์อื่นสำหรับ viewer) |
| UX-R2 | โหมด hover-to-expand sidebar (ปุ่ม lock/unlock) | app-shell | ⚠️ ถ้าทีมไม่ได้ใช้จริง เอาออกเหลือ pinned อย่างเดียว — ลด state + DOM ซ้ำ (ดู UX-F5) |
| UX-R3 | ฟอร์มสลับคู่กางถาวรเหนือ Pairing preview | tables | ✅ พับเป็นปุ่ม "สลับผู้เล่น" เปิด panel/dialog เมื่อต้องใช้ (หน้า games ทำแบบนี้อยู่แล้ว — ให้เหมือนกัน) |

### 3.5 UX — ควร "แก้ไข" (Fix)

| รหัส | รายการ | ที่มา | คำแนะนำ |
|---|---|---|---|
| UX-F1 | **Filter/sort ค้างข้ามเกม** — `resetKey` ที่ผู้เรียกส่งมา DataGrid ไม่เคยทำงาน ผู้ชมเปลี่ยนเกมแล้วข้อมูลโดนกรองด้วยตัวกรองเก่า | data-grid + ทุกหน้า | ✅ implement `resetKey` ให้เคลียร์ filter/sort เมื่อเปลี่ยน (นี่คือ bug ไม่ใช่ choice) |
| UX-F2 | Staff กรอกผลครบแล้วหน้าจอเงียบ ไม่บอกขั้นต่อไป | games | ✅ เมื่อ `allComplete && !isDirector` แสดง notice "กรอกครบแล้ว — รอผู้อำนวยการ Review & Publish" |
| UX-F3 | View picker เป็น segmented แต่ multi-select | card-overview | ⚠️ ทางเลือก: (ก) mobile = single-select (สลับ view แทน toggle ซ้อน), desktop คง multi ได้; (ข) เปลี่ยนหน้าตาเป็น toggle chips ให้สื่อ multi ชัด ๆ |
| UX-F4 | การ์ดถูกลบ/ลิงก์ผิด → CardNotFound มีปุ่ม "กลับไปการ์ดทั้งหมด" ชี้ `/cards` ซึ่ง viewer เข้าไม่ได้ (โดนเด้งไป `/` → login gate) | card-not-found | ✅ ถ้าอยู่ใน /tour ให้ย้อนกลับด้วย hash (leaveCard) แทน |
| UX-F5 | Sidebar เรนเดอร์เมนู 2 ชุด (rail + expanded) สลับด้วย CSS | app-shell | ⚠️ รีแฟคเตอร์เหลือชุดเดียว — ทำพร้อม UX-R2 |
| UX-F6 | ปุ่ม "ปิดการ์ด" (ถาวร) อยู่ header ของ overview ติดกับตัวเลือกดูข้อมูล | card-overview | ✅ ย้ายลงล่างสุดของหน้า/ใส่โซน danger ให้ห่างจาก controls ประจำวัน |
| UX-F7 | PDF download อยู่ใต้หน้า "บันทึกกิจกรรม" | audit | ✅ ย้าย Panel PDF ไปหน้า overview (director เห็น) หรือเปลี่ยนชื่อเมนูเป็น "เอกสาร & บันทึกกิจกรรม" |
| UX-F8 | RealtimeSettingsPanel คั่นกลางเนื้อหา /admin | admin | ✅ ย้ายลงล่างสุด |
| UX-F9 | เมนู "จัดการเจ้าหน้าที่" ไม่สื่อว่ามีสร้างการ์ดอยู่ในนั้น | app-shell, director | ✅ เปลี่ยน label เป็น "คอนโซลผู้อำนวยการ" หรือแยกปุ่มสร้างการ์ดไปหน้า /cards (มีปุ่ม "สร้างการ์ด" ใน /cards อยู่แล้วซึ่งลิงก์มาที่ /director — งงสองต่อ) |

### 3.6 UX — ควร "เพิ่ม" (Add)

| รหัส | รายการ | ที่มา | คำแนะนำ |
|---|---|---|---|
| UX-A1 | จำตัวกรอง "รหัสของฉัน" ของ viewer ต่อ tournament (localStorage) — เปิดแอปซ้ำแล้วตามลูก/ทีมตัวเองได้ทันที | overview-record-filter | ✅ ต่อยอด filter ที่มีอยู่ ไม่แตะ server |
| UX-A2 | สถานะการเชื่อมต่อสด (จุดเขียว "สด" / เหลือง "กำลังเชื่อมต่อใหม่") สำหรับ viewer | use-public-sync + shell | ⚠️ ดีต่อความเชื่อมั่นข้อมูล แต่เพิ่ม state ที่ต้อง maintain |
| UX-A3 | ยืนยันก่อนออกจากหน้า games ถ้ามี draft ยังไม่เซฟ (beforeunload / route guard) | result-entry-grid | ✅ กันข้อมูลพิมพ์ค้างหายเวลาเผลอปิดแท็บ |
| UX-A4 | หน้า /cards ของ staff: ปุ่ม "ทำงานต่อ" เด้งไปการ์ด+ขั้นตอนที่ค้างอยู่ (ตอนนี้ workflow nudge มีเฉพาะใน sidebar) | cards | ⚠️ ทำต่อจาก UI-A1 (ต้องมี stage ต่อการ์ดก่อน) |
| UX-A5 | Empty state ของ viewer ระหว่างรอ pairing เกมถัดไป: บอกว่า "เกม N กำลังแข่ง — ผลจะขึ้นเมื่อเผยแพร่" แทนการเงียบ | card-overview | ✅ ใช้ currentGame/stage ที่มีใน bundle อยู่แล้ว |

---

## 4. โครงสร้าง div ที่ควรเก็บกวาด (สรุปรวม)

1. `card-overview.tsx` — `div.overview-view-section > Panel` (×3) ครอบเพื่อ ref อย่างเดียว → ให้ `Panel` forward ref หรือใช้ `id` + `scrollIntoView`
2. `card-overview.tsx` — `div.overview-ranking-table > RankingTable` ครอบเพื่อ closest() → ใช้ className บน DataGrid wrapper ที่มีอยู่ (`entry-grid-wrap`) แทน
3. `result-entry-grid.tsx` (`ResultViewGrid`) — `div.entry-grid-wrap > div.entry-grid-scroll` ลูกเดียว → ตัด wrap หรือรวม class
4. `tournament-viewer.tsx` — ปุ่ม back ×2 elements → เหลือ 1
5. `app-shell.tsx` — `sidebar__nav-layer` ×2 ชุดเมนูเต็ม → เหลือชุดเดียว
6. `/admin`, `/director` — div + inline style ซ้อนหลายชั้นในทุก list row → นิยาม class `console-row`, `console-row__head`, `console-row__meta`
7. `data-grid.tsx` — `entry-grid-meta-shell > entry-grid-meta` จำเป็นสำหรับ animation เปิด/ปิด (คงไว้ได้ แต่ควรคอมเมนต์เหตุผล)

---

## 5. ลำดับที่แนะนำ (ถ้า validate ผ่าน)

1. **Bug จริงก่อน:** UX-F1 (resetKey), UX-F4 (CardNotFound ใน viewer), UI-R10, UI-R9
2. **Quick wins ข้อความ/ป้าย:** UI-F1, UI-F2, UI-F7, UI-F8, UI-R2, UI-R3, UI-F11, dev-tools badge
3. **Viewer มือถือ:** UX-R1, UI-A2, UX-A5, UI-A1 (ฝั่ง viewer), UI-R5
4. **Console desktop:** UI-F3, UI-F4, UI-F5, UX-F8, UI-A4, UX-F9
5. **โครงสร้าง/รีแฟคเตอร์:** UI-F9, UI-F10, section 4 ทั้งหมด, UX-F5+UX-R2
