# Reavailable: o'rnatish va sozlash (o'zbekcha yo'riqnoma)

Bu yo'riqnoma ikki qismdan iborat: **serverni ishga tushirish** (bir marta, taxminan 10 daqiqa) va
**ilovani telefonga o'rnatish** (5 daqiqa). Shundan keyin kitoblarni qo'shasiz va ularni internetsiz
tinglaysiz.

> **Hali tekshirilmagan:** APK haqiqiy telefonda o'rnatilib, sinovdan o'tkazilmagan. Ovozli buyruqlarning
> telefon mikrofonidagi aniqligi ham tekshirilmagan. Biror qadam ishlamasa, "Muammolar" bo'limiga qarang.

---

## Sizga nima kerak

| Narsa | Nima uchun | Qayerdan |
| --- | --- | --- |
| Android telefon (8.0+) | Ilovani o'rnatish uchun | — |
| GitHub hisobi | Kod va workflow'lar shu yerda | github.com |
| Cloudflare hisobi | Server shu yerda ishlaydi (bepul) | dash.cloudflare.com |
| Azure AI Speech resursi | O'zbekcha ovoz yaratish uchun (F0 — bepul) | portal.azure.com |

Barcha xizmatlar bepul qatlamda ishlaydi: Cloudflare Workers Free, D1, R2 va Azure Speech F0
(oyiga taxminan 500 000 belgi — bu bitta katta kitobga yetadi).

---

## 1-qism. Serverni ishga tushirish

### 1.1. Uchta maxfiy qiymatni (secret) tayyorlang

GitHub'da: **joylashuv (repository) → Settings → Secrets and variables → Actions → New repository secret**.
Uchta secret qo'shing:

**a) `CLOUDFLARE_API_TOKEN`**

1. Cloudflare'da: **My Profile → API Tokens → Create Token**.
2. **Custom token** tanlang. Huquqlar (Permissions):
   - Account → **Workers Scripts** → Edit
   - Account → **D1** → Edit
   - Account → **R2** → Edit
   - Account → **Account Settings** → Read
   - Zone → **Workers Routes** → Edit (ixtiyoriy)
3. Account Resources: o'z hisobingizni tanlang. **Create Token** → ko'rsatilgan qiymatni nusxalang.

> **Muhim:** oldin bu token'ni chatga yozib yuborgansiz. Har qanday chatga yozilgan kalit "ochiq" hisoblanadi.
> Shu sababli eski token'ni **Delete/Roll** qilib, yangi token yarating va faqat GitHub secret'iga yozing.
> R2 S3 kalitlari (Access Key ID / Secret Access Key) bu loyiha uchun **kerak emas** — ularni ham o'chirib
> tashlashingiz mumkin.

**b) `AZURE_SPEECH_KEY`**

1. Azure portal'da o'z resursingizni oching: resurs nomi **Reavailable**, guruh **T1**, hudud **eastus**.
2. Chap menyu: **Resource Management → Keys and Endpoint**.
3. **KEY 1** qiymatini nusxalang (Key 2 ham ishlaydi).

> **Muhim:** Azure kalitini hech qachon chatga, rasmga yoki faylga yozmang. Faqat GitHub secret'iga kiriting.

**c) `AUDIOBOOK_API_KEY`**

Bu — siz o'zingiz tanlaydigan kalit. Ilova serverga murojaat qilganda shu kalitni ko'rsatadi. Uzoq va
tasodifiy bo'lsin, masalan 32 belgidan uzun. Terminal'da yaratish:

```bash
openssl rand -hex 24
```

Qiymatni bir joyga yozib qo'ying: **2-qismda uni ilovaning Sozlamalariga kiritasiz.**

### 1.2. Deploy workflow'ni ishga tushiring

1. GitHub'da: **Actions** bo'limi → chapdan **"Deploy speech server (Cloudflare Workers)"**.
2. **Run workflow** → tarmoq (branch) `arena/d21a1781-reavailable` → **Run workflow**.
3. Sozlamalar (odatda o'zgartirish shart emas):

| Maydon | Standart | Izoh |
| --- | --- | --- |
| `worker_name` | `reavailable-api` | Server manzilining bosh qismi |
| `database` | `reavailable-audiobooks` | D1 baza nomi |
| `bucket` | `reavailable-audiobooks` | R2 bucket nomi |
| `azure_region` | `eastus` | Azure resursingizning hududi |
| `chunks_per_pass` | `8` | Bepul planda 8 qoldiring. Workers Paid bo'lsa `40` qo'ying |
| `require_access_key` | `true` | `false` qilsangiz server kalitsiz ochiq bo'ladi (1.4-qismdagi xavfni o'qing) |

4. Ish tugagach (taxminan 3–6 daqiqa), ish natijasi sahifasidagi **Summary** bo'limida server manzili
   ko'rsatiladi:

```
Server address: https://reavailable-api.<sizning-subdomain>.workers.dev
```

**Shu manzilni saqlab qo'ying.** U avtomatik ravishda ilova kodiga yoziladi va yangi APK shu manzil bilan
quriladi (1.3-qism). Eski APK ishlatsangiz, manzilni qo'lda kiritasiz.

Workflow nima qiladi: R2 bucket va D1 bazani yaratadi (yo'q bo'lsa), migratsiyalarni qo'llaydi, ikkala
kalitni Worker secret sifatida saqlaydi, deploy qiladi va nihoyat tirik manzilni tekshiradi
(`/api/v1/health` va `/api/v1/config`: `provider: azure`, `requires_api_key: true`, `api_key_ok: true`).
Tekshiruv o'tmasa, workflow qizil bo'lib to'xtaydi — demak server ishlamayapti.

### 1.3. Manzil APK'ga o'zi yoziladi

Qo'shimcha ish qilmaysiz. Deploy workflow server manzilini ilova kodiga
(`mobile/src/core/config.ts`) yozadi, uni branch'ga commit qiladi va yangi teg
(`android-v0.2.0-server<run-raqami>`) bosadi. Shu teg orqali **manzili tayyor APK** avtomatik quriladi va
**Releases** sahifasida pre-release sifatida chiqadi (taxminan 10 daqiqa).

Ya'ni 1.2-qismdan keyin Releases'dagi **eng yangi** pre-release'ni oling: unda server manzili allaqachon
kiritilgan, siz faqat **kirish kalitini** yozasiz.

> Eski APK (`android-v0.2.0-test1`) ham ishlaydi — unda manzilni qo'lda kiritasiz (2.3-qism).

### 1.4. (Ixtiyoriy) Kirish kalitsiz server

`AUDIOBOOK_API_KEY` secret'ini qo'shmoqchi bo'lmasangiz, workflow'ni ishga tushirishda
**`require_access_key: false`** ni tanlashingiz mumkin. U holda ilovaga hech narsa kiritish kerak emas:
manzil APK'da tayyor, kirish kaliti so'ralmaydi.

**Lekin bu xavfsiz emas.** Bu repo **ochiq (public)**, shuning uchun server manzili ham ochiq. Manzilni
bilgan har kim serverda kitob yarata oladi va sizning **Azure bepul kvotangizni** (oyiga ~500 000 belgi)
sarflab yuboradi. Shu sababli standart qiymat `true`: kalitni bir marta kiritasiz va server yopiq bo'ladi.

---

## 2-qism. Ilovani o'rnatish

### 2.1. APK'ni yuklab oling

1. GitHub'da: **Releases** → eng yangi pre-release. Server deploy qilingan bo'lsa, eng yangisi
   `android-v0.2.0-server<N>` bo'ladi va unda manzil tayyor; bo'lmasa `android-v0.2.0-test1` ni oling.
2. **Assets** ro'yxatidan telefoningizga mos **bitta** APK tanlang:

| Fayl | Kim uchun | Hajmi |
| --- | --- | --- |
| `app-arm64-v8a-release.apk` | 2017-yildan keyingi telefonlar (deyarli barchasi) | taxminan 70 MB |
| `app-armeabi-v7a-release.apk` | Eski 32 bitli telefonlar | taxminan 70 MB |

   Qaysi biri sizniki ekanini bilmasangiz — **arm64** ni oling. "O'rnatilmadi" yoki "Parse error" desa,
   **armv7** ni sinab ko'ring.

3. Iloji bo'lsa **Wi-Fi** orqali yuklang: fayl katta, mobil internetda uzilib qolishi mumkin. Chrome
   yuklab olishni boshlaganda "Bu turdagi fayl zararli bo'lishi mumkin" deb ogohlantiradi → **Keep**
   ("Saqlab qolish") ni bosing. Bu barcha APK fayllar uchun standart ogohlantirish.
4. (Ixtiyoriy) Fayl butunligini tekshirish:

```bash
sha256sum -c app-arm64-v8a-release.apk.sha256
```

`OK` chiqsa, fayl buzilmagan.

Yuklab olish yoki o'rnatish bilan muammo bo'lsa, pastdagi "Muammolar" jadvaliga qarang.

### 2.2. O'rnating

1. Telefonda yuklangan APK faylini (masalan `app-arm64-v8a-release.apk`) oching.
2. Android "Noma'lum manbalardan o'rnatish"ni so'raydi: **Sozlamalar → bu brauzer/fayl menejeri →
   "Allow from this source"** ni yoqing.
3. **Install** ni bosing.

> APK **debug imzo** bilan imzolangan. Bu sinov uchun: Play Store'ga joylab bo'lmaydi, lekin oddiy
> o'rnatish (sideload) ishlaydi. Ilova o'zbek tilida ochiladi.

### 2.3. Ilovani sozlang

Ilovani oching → **Kutubxona** ekranida **"Sozlamalar"** tugmasi:

1. **Interfeys tili** — `O'zbekcha` (standart) yoki `English`. Tanlash darhol amal qiladi.
2. **Server manzili** — yangi APK'da bu maydon **to'ldirilgan** keladi. Eski APK bo'lsa, 1.2-qismdagi
   manzilni yozing: `https://reavailable-api.<subdomain>.workers.dev`.
   - Manzil `https://` bilan boshlanishi shart (release versiya oddiy `http://` ni qabul qilmaydi).
   - Oxirida `/` belgisi bo'lmasa ham bo'ladi.
3. **Kirish kaliti** — `AUDIOBOOK_API_KEY` qiymati.
4. **"Ulanishni tekshirish"** ni bosing. Muvaffaqiyatli javob shunday ko'rinadi:

```
Ulandi. Server versiyasi 0.2.0. Mavjud ovozlar: uz-UZ-MadinaNeural, uz-UZ-SardorNeural. Standart: uz-UZ-MadinaNeural.
```

5. **"Saqlash"** ni bosing.

> Kalit telefonning xavfsiz xotirasida (Keystore) saqlanadi, kitob tokenlari ham shu yerda. Audio fayllar
> ilovaning o'z xotirasida turadi.

### 2.4. Birinchi kitobni qo'shing

1. Kutubxonada **"Kitob qo'shish"**.
2. **Sarlavha** yozing.
3. **Matn** maydoniga o'zbekcha matnni joylang yoki **".txt yoki .md fayl yuklash"** tugmasi bilan fayl
   tanlang (UTF-8, 1 MB gacha).
4. **Qism uzunligi** — 1 yoki 2 gap. Qisqa qismlar tezroq boshlanadi (birinchi audio tezroq keladi),
   2 gap tabiiyroq eshitiladi.
5. **"Audiokitob yaratish"**.

Kitob ro'yxatda **"Serverda tayyorlanmoqda"** deb ko'rinadi. Server audio yaratgach, telefon qismlarni
yuklab oladi: **"3 qismdan 1 tasi shu telefonda"** kabi yozuvni ko'rasiz. Birinchi qism telefonga tushishi
bilan **"Ochish"** tugmasi yonadi — yuklab olish davom etayotganida ham tinglashni boshlashingiz mumkin.

Barcha qismlar tushgach holat **"Oflayn tayyor"** bo'ladi. Shundan keyin internet kerak emas.

### 2.5. Tinglash va ovozli buyruqlar

Ekrandagi tugmalar: **Ijro / Pauza**, **Keyingi**, **Takror**. Qismlar ro'yxatidan istalgan qismni bosib
o'tish mumkin.

Ovozli boshqaruv uchun Sozlamalar → **Ovozli buyruqlar** ni yoqing. Buyruqlar **inglizcha** va ular
**telefonda** aniqlanadi (internet kerak emas):

| Buyruq | Nima qiladi |
| --- | --- |
| `next` | Keyingi qismga o'tadi |
| `repeat` | Joriy qismni boshidan takrorlaydi |
| `pause` | To'xtatadi |
| `resume` | Davom ettiradi |

Ilova o'zbek nutqini **umuman** tanimaydi — bu maxsus shunday qilingan: mikrofon faqat ovozli buyruqlar
yoqilganda ishlaydi va hech qanday audio serverga yuborilmaydi.

**Maslahat:** quloqchin ishlating. Dinamikdan chiqayotgan ovoz mikrofonga tushib, tasodifan buyruq deb
qabul qilinishi mumkin.

---

## Muammolar

| Nima ko'rdingiz | Sabab va yechim |
| --- | --- |
| "Ulanish yo'q" / "Server javob berishga kechikdi" | Internet yoki manzil noto'g'ri. Manzilni `https://` bilan, xatosiz kiriting |
| `Server javob berdi, lekin bu kirish kalitini qabul qilmadi` | Kalit noto'g'ri. GitHub'dagi `AUDIOBOOK_API_KEY` bilan ilovadagi qiymat bir xil bo'lsin |
| `Nutq xizmati sozlanmagan` (503 `server_misconfigured`) | Worker'da `AZURE_SPEECH_KEY` yo'q. Deploy workflow'ni qayta ishga tushiring |
| `Nutq xizmati vaqtincha ishlamayapti` | Azure kaliti/hududi noto'g'ri, yoki F0 kvota tugagan. Hudud `eastus` ekanini tekshiring |
| `Bu ovoz serverda yoqilmagan` | `ALLOWED_VOICES` ro'yxatida yo'q ovoz so'ralgan. Standart ovozlarni ishlating |
| Kitob uzoq vaqt "Serverda tayyorlanmoqda" | Bepul planda har bir so'rovda 8 qism yaratiladi. Ilova holatni so'rab turgani sayin davom etadi. Katta kitob uchun bir necha daqiqa kutish normal |
| "Ba'zi qismlar telefondan o'chib ketgan" | Ilova ma'lumotlari tozalangan yoki fayllar o'chirilgan. Kitobni o'chirib, qaytadan qo'shing |
| Serverdagi nusxa muddati tugagan (24 soat) | Telefon allaqachon yuklab olgan qismlar **saqlanadi**. Yetishmayotgan qismlar uchun kitobni qayta qo'shing |
| Ovozli buyruqlar ishlamayapti | Sozlamalarda "Bu versiyada ovozli buyruqlar mavjud emas" yozuvi bormi? Bo'lsa, bu APK'da nutq moduli yo'q — yangi release APK'ni o'rnating |
| Ilova `http://` manzilni qabul qilmayapti | Release versiya faqat HTTPS ishlatadi. Workers.dev manzili avtomatik HTTPS |
| APK yuklanmayapti yoki yarim yo'lda to'xtaydi | Wi-Fi ishlating. Telefonda kamida 500 MB bo'sh joy bo'lsin. Yuklab olishni qayta boshlang (Chrome → Downloads). Eski release emas, **eng yangi** release'dan oling |
| "Faylni ochib bo'lmadi", "Parse error" yoki "O'rnatilmadi" | Noto'g'ri arxitektura tanlangan: `arm64` o'rniga `armv7` APK'ni sinang (yoki aksincha). Shuningdek telefonda "Noma'lum manbalardan o'rnatish" ruxsati yoqilgan bo'lsin |
| Chrome APK'ni yuklashdan bosh tortdi | Ogohlantirishda **Keep** ("Saqlab qolish") ni bosing. Yoki havolani fayl menejeri/boshqa brauzer orqali oching |
| Yuklab olish juda sekin | GitHub fayllari ba'zi mintaqalarda sekin beriladi. Wi-Fi'ni sinang, yoki kompyuterda yuklab olib telefonga (USB/Telegram) o'tkazing |

Agar deploy workflow qizil bo'lsa: **Actions → ishni oching → "Check the required secrets"** yoki
**"Check the deployed server"** qadamidagi xatoni o'qing. Ko'pincha secret nomi noto'g'ri yoki Cloudflare
token'ida D1/R2 huquqi yo'q.

---

## Xavfsizlik

- Uchala kalitni (Cloudflare token, Azure kalit, `AUDIOBOOK_API_KEY`) hech kimga yubormang va chatga
  yozmang. Agar birortasi oshkor bo'lgan bo'lsa — darhol almashtiring.
- Azure F0 bepul qatlam pul yozmaydi: agar kalit oshkor bo'lsa, kimdir uni ishlatsa, faqat oylik kvota
  tugaydi. Baribir kalitni almashtirgan yaxshi.
- Matn serverda faqat audio yaratilgunga qadar turadi: telefon har bir qismni tasdiqlagach, server o'z
  nusxasini o'chiradi. Tasdiqlanmagan ishlar 24 soatdan keyin o'chiriladi.
- Ilova faqat kerakli ruxsatlarni so'raydi: internet, mikrofon (ovozli buyruqlar uchun), audio ijro.

## Qo'shimcha ma'lumot

- Server tafsilotlari: [worker/README.md](../worker/README.md)
- Ilova tafsilotlari: [mobile/README.md](../mobile/README.md)
- Arxitektura: [ARCHITECTURE.md](ARCHITECTURE.md)
- Nima test qilingan va nima qilinmagan: [TESTING.md](TESTING.md)
