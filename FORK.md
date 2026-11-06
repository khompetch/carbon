# Fork workflow (khompetch/carbon)

fork นี้ต่อยอดจาก [crbnos/carbon](https://github.com/crbnos/carbon) โดยยังรับ update จาก upstream ต่อเนื่อง

## Branches

| Branch | หน้าที่ | กฎ |
|---|---|---|
| `main` | สำเนาตรงของ `upstream/main` ห้าม commit เอง | ห้ามลบ, ห้าม force push |
| `develop` | trunk ของบริษัท = upstream + feature ของเรา (default branch) | ต้องผ่าน PR, merge แบบ **Merge** เท่านั้น |
| `production` | สิ่งที่ Dokploy deploy | ต้องผ่าน PR, merge แบบ **Merge** เท่านั้น |
| `feature/*` | งานใหม่ แตกจาก `develop` | ลบหลัง merge |
| `sync/upstream-YYYY-MM-DD` | รอบ sync upstream | ลบหลัง merge |

งานเก่าก่อนจัดโครง (2026-10-31) เก็บไว้เป็น tag `archive/2026-10-31/*`

## Feature ใหม่

```bash
git switch develop && git pull --ff-only
git switch -c feature/<name>
# ... commit ...
git push -u origin feature/<name>
gh pr create --base develop
```

## Sync upstream (สัปดาห์ละครั้ง)

1. GitHub → `main` → **Sync fork**
2. merge เข้า develop
   ```bash
   git fetch origin
   git switch -c sync/upstream-$(date +%F) origin/develop
   git merge origin/main
   pnpm db:migrate && pnpm run generate:types
   pnpm exec turbo run typecheck --filter=erp --filter=mes --filter=@carbon/ee
   git push -u origin HEAD && gh pr create --base develop
   ```
3. แก้ conflict ตาม skill `resolving-merge-conflicts` และห้ามแก้ generated types ด้วยมือ (ให้ regenerate)

## Release

PR จาก `develop` เข้า `production` แล้ว Dokploy deploy

## ลด conflict กับ upstream

- วางโค้ดของเราในไฟล์หรือโฟลเดอร์ใหม่ แก้ไฟล์ของ upstream เฉพาะจุดลงทะเบียน (เพิ่มบรรทัด)
- ห้าม refactor หรือ format โค้ดของ upstream
- จุดที่จำเป็นต้องแก้ไฟล์ upstream ให้ใส่ comment `// FORK: <เหตุผล>` และบันทึกไว้ในตารางด้านล่าง
- migration: สร้างตารางของเราเอง อย่าแก้ตารางของ upstream และเขียนแบบ idempotent
- `git config rerere.enabled true`

## จุดที่แก้ไฟล์ upstream

| ไฟล์ | เหตุผล |
|---|---|
| _(ยังไม่มี)_ | |
