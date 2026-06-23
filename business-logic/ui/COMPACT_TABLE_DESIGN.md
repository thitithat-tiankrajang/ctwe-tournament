# Compact Table Design

## Goal

หน้าจอการแข่งขันต้องให้เจ้าหน้าที่สแกนข้อมูลจำนวนมากได้เร็ว โดยทุก record ใน data table ใช้ **หนึ่งแถวและหนึ่งบรรทัดจริง** ให้มากที่สุด ไม่ใช้รูปแบบ card ต่อ record

## Scope

- ใช้กับ `.data-table` ทุกหน้า: Overview, Players, Tables, Results และ Audit log
- ใช้กับตาราง archive ที่มีชื่อ `...ที่บันทึกไว้ตามเกม`
- ไม่ใช้กับ competition card, physical table, form panel, dialog หรือ card/grid อื่น

## Density rules

| Element | Target |
| --- | --- |
| Table header | 28px โดยประมาณ |
| Data row | 30–32px โดยประมาณ |
| Cell padding | 3–4px แนวตั้ง, 7–8px แนวนอน |
| Primary text | 11–12px |
| Secondary metadata | 9–10px และอยู่บรรทัดเดียวกับ primary text |
| Badge / row action | สูงไม่เกิน 26px |
| Archive game selector | สูงประมาณ 56px ต่อ game |

## Content behavior

1. ชื่อ, รหัส และสถาบันต้องอยู่ในบรรทัดเดียว เช่น `สมชาย ใจดี · P0042 · โรงเรียนตัวอย่าง`
2. Cell ห้าม wrap โดยค่าเริ่มต้น ข้อมูลยาวใช้ ellipsis หรือเลื่อนแนวนอนที่ table container
3. ตัวเลขจัดชิดขวาและใช้ tabular numerals เพื่อเทียบค่าในแนวตั้งได้ง่าย
4. Header ของตารางยาวต้อง sticky เมื่อเลื่อนใน container
5. บนจอเล็กยังคงเป็น table และเลื่อนแนวนอน ไม่แปลงแต่ละ record เป็น card
6. Edit mode อนุญาตให้สูงขึ้นเท่าที่จำเป็นสำหรับ validation แต่เมื่อไม่ได้ edit ต้องกลับสู่ความสูงมาตรฐานทันที

## Archive layout

Archive หนึ่งชุดประกอบด้วย Game selector, summary หนึ่งบรรทัด และ table ต่อเนื่องกัน ห้ามมี padding ซ้ำระหว่างสามส่วน และ table container ไม่มีความสูงขั้นต่ำที่สร้างพื้นที่ว่างโดยไม่จำเป็น

## Acceptance criteria

- Record ปกติทุกแถวมี computed height ไม่เกิน 34px ที่ desktop viewport
- ชื่อและ metadata ของผู้เล่นไม่สร้างบรรทัดที่สอง
- การรัน `next build` หรือการเปลี่ยน viewport ไม่ทำให้ table กลายเป็น card
- Competition cards และ physical table cards คง layout เดิม
