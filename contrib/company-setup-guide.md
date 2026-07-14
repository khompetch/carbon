# Company — Carbon Setup Guide

คู่มืออ้างอิงการตั้งค่า master data และ workflow สำหรับโรงงาน Company
(PD1–PD7 + MTP, รั้วเดียวกัน, คลัง WHL ร่วมกัน, เดิน 2 กะรวม OT ตลอด 24 ชม.)

สรุปจากการวิเคราะห์ร่วมกับ schema จริงของระบบ เมื่อ 2026-07-10
เอกสารที่เกี่ยวข้อง: [.ai/specs/2026-07-09-oee-dashboard.md](../.ai/specs/2026-07-09-oee-dashboard.md)

---

## บริบทโรงงาน

| หน่วยผลิต | สินค้า | ลักษณะงานหลัก |
|---|---|---|
| PD1 | บรรจุภัณฑ์อาหารจากพลาสติก (food-grade, mass production) | Thermoforming |
| PD2 | อุปกรณ์ประดับยนต์ (Liner, Floormat) | Thermoforming |
| PD3 | ยางฉนวน (ป้อนแผนกอื่นด้วย) | Rubber Mixing / Extrusion / Vulcanizing |
| PD4 | หลังคา Canopy + ชุดติดตั้ง | FRP/Composite Forming + Assembly |
| PD5 | Blow Mold / Injection ชิ้นเล็ก-กลาง + พ่นสี + ประกอบ | Blow Molding, Injection, Painting, Assembly |
| PD6 | Blow Mold / Injection ชิ้นกลาง-ใหญ่ + พ่นสี + ประกอบ | Blow Molding, Injection, Painting, Assembly |
| PD7 | โครงเหล็กหลังกระบะ, โรลบาร์ (safety-critical) | Metal Cutting / Bending / Welding |
| MTP | โครงเหล็กหลังคา + ประกอบชุดกระจก (ป้อน PD4) | Welding, Assembly |

---

## 1. Location — ตั้งตัวเดียว

> **หลักการ:** Location = ขอบเขตความเป็นเจ้าของสต็อก + งาน ไม่ใช่ป้ายชื่อแผนก
> รั้วเดียวกัน + คลังร่วมกัน = location เดียวเสมอ

- **Resources → Locations**: สร้าง 1 ตัว เช่น "Company Factory"
- **timezone ต้องเป็น `Asia/Bangkok`** (บังคับกรอก — กะและ OEE คำนวณจากค่านี้)

**ห้ามแยก PD เป็นหลาย location** เพราะ:
- ทุกการจ่ายวัตถุดิบจะกลายเป็น warehouse transfer สองจังหวะ (ship → receive) วันละหลายสิบใบ
- Job เบิกของได้เฉพาะ location ตัวเอง — flow MTP→PD4 และ PD3→แผนกอื่น จะพังทันที
- MRP/ยอดสต็อก/จุดสั่งซื้อ แตกเป็นหลายชุด

## 2. Shifts — 2 กะรวม OT

**People → Shifts** (`/x/people/shifts`) ผูกกับ location เดียวกัน:

| ชื่อกะ | เวลา | วัน |
|---|---|---|
| กะเช้า + OT | 08:00 – 20:00 | ติ๊กตามวันทำงานจริง |
| กะดึก + OT | 20:00 – 08:00 (ข้ามคืน — ระบบรองรับ) | ติ๊กตามวันที่**เริ่ม**กะ |

ข้อควรรู้:
- สองกะต่อกันพอดี = เวลาแผน (Planned time) 24 ชม./วันที่ติ๊ก ระบบ merge รอยต่อให้ ไม่นับซ้ำ
- Runtime ของ OEE **ไม่ถูกตัดตามกรอบกะ** — ถ้าตั้งกะสั้นกว่าเวลาทำงานจริง Availability จะเกิน 100% ได้
  ดังนั้นเมื่อ OT เป็นเรื่องปกติ ให้ตั้งรวม OT แบบนี้ถูกแล้ว
- วันที่กะดึกไม่เดินจริง (ไม่มี OT) Availability วันนั้นจะดูต่ำเพราะตัวส่วนยังนับ 24 ชม.
  — ข้อจำกัด v1 อ่านค่าโดยรู้บริบท (ดู §8 งานต่อยอด v2)
- ถ้าอยากตัดพักเที่ยง/พักกะออกจากเวลาแผน: แตกกะเป็นช่วงย่อย เช่น 08:00–12:00 + 13:00–20:00

## 3. Work Centers — PD อยู่ในชื่อ (prefix) ไม่ใช่ใน location

**Resources → Work Centers**: ทุกตัวต้อง **active + ระบุ location** (OEE ข้ามเครื่องที่ไม่ผ่านเงื่อนไขนี้ทิ้ง)

ความละเอียดต่างกันตามประเภทงาน:

| ประเภทงาน | หน่วย work center | ตัวอย่างชื่อ |
|---|---|---|
| เครื่องขึ้นรูป (ฉีด เป่า thermoform กดยาง) | **รายเครื่อง** | `PD5-INJ-01`, `PD1-THF-02`, `PD3-RUB-01` |
| ไลน์พ่นสี / ไลน์ประกอบ | **รายไลน์** | `PD5-PAINT-L1`, `MTP-ASSY-L1` |
| งานโลหะ | รายเครื่อง/สถานีหลัก | `PD7-CUT-01`, `PD7-WLD-01`, `MTP-WLD-01` |

เหตุผลที่ขึ้นรูปต้องรายเครื่อง:
- production event ผูก `workCenterId` ตัวเดียว → ความละเอียดของ OEE = ความละเอียดของ work center
- downtime งานซ่อมบำรุง (maintenance dispatch) หักเป็นราย work center
- ถ้ารวมหลายเครื่องใน work center เดียว Runtime ถูก merge intervals — เดิน 3 เครื่องพร้อมกันได้ตัวเลขเท่าเดินเครื่องเดียว ตีความไม่ได้

ราคาที่จ่าย: พนักงานหน้างานต้อง**เลือกเครื่องให้ถูกตัว**ตอนกดเริ่มงานใน MES — เลือกมั่ว = ตัวเลขรายเครื่องเชื่อไม่ได้

## 4. Processes — ชนิดงานกลาง ๆ ใช้ร่วมทุก PD (ห้ามแยกราย PD)

> **หลักการ:** Process ตอบคำถาม "งาน**อะไร**" / Work Center ตอบคำถาม "ทำ**ที่ไหน**"
> ห้ามยัดชื่อ PD เข้าไปใน process เด็ดขาด

รายการตั้งต้น:

- Thermoforming (PD1, PD2)
- Blow Molding (PD5, PD6)
- Injection Molding (PD5, PD6)
- Rubber Mixing / Extrusion / Vulcanizing (PD3)
- FRP/Composite Forming (PD4)
- Metal Cutting / Bending / Welding (PD7, MTP)
- Painting (PD5, PD6)
- Assembly (PD4, PD5, PD6, MTP) — แยก Glass Assembly ให้ MTP ได้ถ้าต้องการ

แล้วผูกความสามารถผ่าน **workCenterProcess** (เครื่องไหนทำ process ไหนได้) — โดยเฉพาะเครื่องฉีด/เป่าของ
PD5 และ PD6 ให้ผูก process เดียวกัน เพื่อให้ฝ่ายวางแผนย้ายงานข้ามสองแผนกนี้ได้ตอนคิวเต็ม/เครื่องเสีย

เหตุผลที่ห้ามแยกราย PD — process เป็น master data ที่มี 9 ระบบเกาะ (FK จริงใน schema):
สูตรการผลิต (`methodOperation`), ใบเสนอราคา (`quoteOperation`), scheduling (`workCenterProcess`),
work instructions (`procedure`), quality NCR, training, งานจ้างนอก (`supplierProcess`),
job routing, shelf-life trigger — แยกราย PD = ทุกอย่างแตกเป็น 7–8 สำเนาที่ต้องดูแลให้ตรงกันตลอดไป

## 5. คลัง — Warehouse ตามหน้าที่ ภายใน location เดียว

> **หลักการ:** Location = เจ้าของสต็อก / Warehouse = กติกาการไหล / Storage Unit = ตำแหน่งวางจริง
> แบ่งที่ชั้นต่ำสุดที่ตอบโจทย์เสมอ — เริ่มหยาบ แตกละเอียดเมื่อเจ็บจริง

```
Location: Company Factory
├── WHL-RM   คลังวัตถุดิบ    → เปิด requiresPutAway / requiresPick
├── WHL-FG   คลังสำเร็จรูป   → เปิด requiresShipment
└── Lineside bins (storage units): PD ละ 1 ตัวก่อน
      PD1-LINESIDE, PD2-LINESIDE, ... MTP-LINESIDE
      (แตกย่อยรายโซน เช่น PD5-PAINT-LINESIDE เฉพาะเมื่อพื้นที่กองของแยกกันจริง
       และเคยมีปัญหาหาของไม่เจอ — ทุก bin ที่เพิ่ม = แรงสแกนที่หน้างานแบกทุกวัน)
```

- ของบน lineside **ยังนับเป็น on-hand ของโรง** → MRP ไม่สั่งซื้อซ้ำ, งานเลื่อนก็ดึงกลับคลังได้
- warehouse ไม่ใช่กำแพงกันของข้ามแผนก — ถ้าต้องกันของ food-grade ให้ใช้วินัย + default pick
  (`pickMethod`) + storage rules

### สินค้ากึ่งสำเร็จรูปภายใน (ไม่ต้องโอนคลัง)

- โครงเหล็ก MTP → PD4 และยางฉนวน PD3 → แผนกอื่น: ตั้งเป็น **item + BOM sub-assembly**
  ของสินค้าปลายทาง (methodType: Make to Order = ผลิตพ่วง job แม่ / Pull from Inventory = ผลิตเข้าสต็อกแล้วเบิก)
- Demand ของ MTP/PD3 จะถูกดึงอัตโนมัติผ่าน MRP จากออเดอร์ของแผนกปลายทาง

## 6. การไหลของวัตถุดิบ — 3 จังหวะ

| เครื่องมือ | ใช้เมื่อ | ผลต่อสต็อก | ผลต่อบัญชี |
|---|---|---|---|
| **Picking List** | จัดของป้อน job — generate จาก BOM, แนะนำ lot แบบ FEFO, เช็คของพอ/ขาด (สถานะ Short) | ย้ายชั้น (คลัง → lineside) ยอดไม่ลด | ไม่มี |
| **Issue** (สแกน หรือ backflush) | ใช้ของจริงตอนผลิต | **ตัดสต็อกจริง** + lot เป็น Consumed | credit inventory → debit WIP ("Job Consumption") |
| **Stock Transfer** | ย้ายตำแหน่งทั่วไปในรั้ว (จัดระเบียบ/เติมหน้าไลน์แบบไม่ผูก job/ดึงของคืน) | ย้ายชั้น ยอดไม่ลด | ไม่มี |
| **Warehouse Transfer** | ข้าม location เท่านั้น (สองจังหวะ ship → receive, มีของ in-transit) | ลดต้นทาง เพิ่มปลายทาง | — |

**Flow มาตรฐาน:** วางแผน → generate picking list → คลังจัดของ (FEFO) วางที่ `PDx-LINESIDE`
→ ระบบอัปเดต `jobMaterial.storageUnitId` ชี้ lineside เอง → ผลิต → issue/backflush ตัดจาก lineside

กติกาจำง่าย: **ของยังอยู่ในรั้ว = Stock Transfer / ของออกจากรั้ว = Warehouse Transfer**

## 7. Tracking type ต่อ item — ตัวตัดสิน backflush vs สแกน

> ไม่มีสวิตช์ "เปิด backflush" — พฤติกรรมถูกอนุมานจาก tracking type ของ item:
> ไม่ track = backflush อัตโนมัติ / Batch หรือ Serial = บังคับสแกนเสมอ

| กลุ่มของ | Tracking | ผลหน้างาน |
|---|---|---|
| เม็ดพลาสติก สี กาว น็อต วัสดุสิ้นเปลือง | **ไม่ track** | Backflush — ระบบตัดตาม BOM ตามสัดส่วนยอดเสร็จ ไม่ต้องสแกน |
| วัตถุดิบ food-grade (PD1), วัสดุ safety-critical (PD7) | **Batch** | สแกน lot ตอนใช้ + ด่านของหมดอายุ (นโยบายบริษัท default = Block) |
| FG มูลค่าสูงรายชิ้น: โรลบาร์ PD7, Canopy PD4, โครง+กระจก MTP | **Serial** | ทำ/รายงานทีละชิ้น (จำนวนล็อกที่ 1), พิมพ์ป้ายต่อชิ้น, genealogy รายชิ้น |
| FG บรรจุภัณฑ์อาหาร PD1 | **Batch** (ห้าม Serial) | mass production รายงานยอดรวมได้ปกติ, recall เป็นระดับ lot ซึ่งพอสำหรับมาตรฐานอาหาร |

ข้อควรระวัง:
- **Backflush ตัด "เท่าสูตร BOM เป๊ะ"** — วัตถุดิบที่ใช้จริงเกินสูตรบ่อย (หกเสีย/ตั้งเครื่องเปลือง)
  สต็อกในระบบจะสูงกว่าจริงสะสม → ของกลุ่มนี้ควร issue ด้วยมือแม้ไม่ track lot
- ป้าย lot เกิดตอน **รับของเข้า (Receipt)** — ต้องมีเครื่องพิมพ์ label (รองรับ ZPL) ที่จุดรับของ
- Scanner USB/Bluetooth แบบ keyboard ธรรมดาใช้ได้เลย ไม่ต้องมีฮาร์ดแวร์พิเศษ
- งานผลิต Serial: ระบบบังคับ issue วัตถุดิบ tracked ครบก่อนปิดชิ้น (กัน genealogy โหว่)
  และมีแท็บ Unconsume สำหรับถอนการเบิกที่ยิงผิด

## 8. OEE Dashboard — เงื่อนไขให้ข้อมูลแสดง

หน้า **Production → OEE** (`/x/production/oee`) ต้องมีสิทธิ์ view Production

```
OEE = Availability × Performance × Quality
  Availability = Runtime (production events) ÷ Planned (กะของ location − downtime ซ่อมบำรุง)
  Performance  = เวลามาตรฐานที่ทำได้ ÷ Runtime
  Quality      = Production ÷ (Production + Scrap + Rework)
```

Checklist เปิดใช้ (เรียงลำดับ):

1. [ ] Location + timezone (§1)
2. [ ] Shifts active (§2) — **จุดที่พลาดบ่อยสุด: ไม่มีกะ = Availability/OEE ว่างทั้งหน้า**
3. [ ] Work centers active + ระบุ location (§3)
4. [ ] Operation ใน routing มี standard time (setup/labor/machine) — ไม่มี = Performance 0%
5. [ ] หน้างานใช้ MES จริง: กดเริ่ม/จบงาน + บันทึกยอดผลิต/scrap พร้อม scrap reason
6. [ ] งานซ่อมบำรุงระบุ `oeeImpact` (Down/Planned) + เวลาเริ่ม/จบจริง → downtime ถูกหักรายเครื่อง
7. [ ] เปิดหน้า OEE เลือกช่วงเวลาครอบคลุมวันที่มีงาน (ช่วงรวมวันนี้ = มี Live refresh ~15 วิ)

แนวการอ่านค่า (แต่ละ PD ผลิตของคนละประเภท — เทียบข้าม PD ตรง ๆ ไม่ยุติธรรม):

1. เทียบ PD กับตัวเองข้ามช่วงเวลา (trend badge)
2. เทียบเครื่องภายในกลุ่มเดียวกัน (`PD5-INJ-01` vs `PD5-INJ-02`)
3. เทียบ process เดียวกันข้ามแผนก (toggle Process: Injection PD5 vs PD6)
4. Scrap Pareto — PD1 ตั้ง scrap reason ละเอียดกว่าแผนกอื่น (Quality คือแกนหลักของ food-grade)

## 9. งานต่อยอดที่เปิดประเด็นไว้ (ยังไม่ได้ทำ)

| งาน | ทำเมื่อ |
|---|---|
| **OEE v2 — ปฏิทินกะราย work center** (spec ระบุเป็น v2 ไว้แล้ว: ต้องมี migration ผูก WC↔shift + UI + fallback ไปกะ location) | เมื่อกะของแต่ละ PD ต่างกันจริง — v1 ทุกเครื่องหารด้วยเวลาแผนเดียวกัน เครื่องกะน้อยจะดูแย่กว่าจริงอย่างเป็นระบบ |
| **Roll-up ราย PD บนหน้า OEE** (group ตาม prefix ชื่อ WC — งานฝั่ง UI/route เดียว ไม่แตะ schema) | เมื่ออยากเห็น OEE เป็นรายแผนกโดยไม่ต้องกวาดตาจาก prefix |
| **ร่าง master data จริงเตรียม import** (work centers / processes / warehouses / storage units จากรายชื่อเครื่องจริง) | ก่อนเริ่มตั้งค่าจริง |
