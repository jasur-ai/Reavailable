/**
 * The complete string catalogue of the app: every key exists in Uzbek and in English.
 *
 * `{name}` placeholders are filled in by the translator. Adding a key without both languages is a
 * type error, so the catalogue cannot silently fall back to English in an Uzbek sentence.
 */

export const STRINGS = {
  // ---------------------------------------------------------------- common
  'common.back': { uz: 'Orqaga', en: 'Back' },
  'common.save': { uz: 'Saqlash', en: 'Save' },
  'common.cancel': { uz: 'Bekor qilish', en: 'Cancel' },
  'common.remove': { uz: "O'chirish", en: 'Remove' },
  'common.retry': { uz: 'Qayta urinish', en: 'Retry' },
  'common.open': { uz: 'Ochish', en: 'Open' },
  'common.on': { uz: 'Yoqilgan', en: 'On' },
  'common.off': { uz: "O'chirilgan", en: 'Off' },

  // ---------------------------------------------------------------- library
  'library.title': { uz: 'Kutubxona', en: 'Library' },
  'library.settings': { uz: 'Sozlamalar', en: 'Settings' },
  'library.serverNeeded': {
    uz: "Kitob qo'shishdan oldin Sozlamalarda server manzilini kiriting.",
    en: 'Set the server address in Settings before adding a book.',
  },
  'library.addBook': { uz: "Kitob qo'shish", en: 'Add a book' },
  'library.addBookHint': {
    uz: 'Matn joylash yoki fayl tanlash oynasini ochadi',
    en: 'Opens a form to paste or load a transcript',
  },
  'library.emptyTitle': { uz: "Hali kitob yo'q", en: 'No books yet' },
  'library.emptyBody': {
    uz: "O'zbekcha matn qo'shing. Server uni qisqa qismlarga bo'lib ovozga aylantiradi, telefoningiz ularni saqlaydi, "
      + 'shundan keyin internetsiz tinglaysiz va ijroni inglizcha ovozli buyruqlar bilan boshqarasiz.',
    en: 'Add an Uzbek text. The server turns it into audio in short parts, your phone stores them, and you can then '
      + 'listen offline and control playback with English voice commands.',
  },
  'library.removeTitle': { uz: "Bu kitob o'chirilsinmi?", en: 'Remove this book?' },
  'library.removeBody': {
    uz: "Audio shu telefondan o'chiriladi. Agar serverda ham nusxasi bo'lsa, u ham o'chiriladi. Buni qaytarib bo'lmaydi.",
    en: 'The audio is deleted from this phone. If the server still has it, the server copy is deleted too. '
      + 'This cannot be undone.',
  },
  'library.voiceLabel': { uz: 'Ovoz: {voice}', en: 'Voice: {voice}' },
  'library.voiceMadina': { uz: 'Madina (ayol)', en: 'Madina (female)' },
  'library.voiceSardor': { uz: 'Sardor (erkak)', en: 'Sardor (male)' },
  'library.cyrillicNote': {
    uz: "Kirill matni bor (noto'g'ri talaffuz qilinishi mumkin)",
    en: 'Contains Cyrillic text (may be mispronounced)',
  },
  'library.progressLabel': { uz: '{title} yuklanishi', en: '{title} progress' },
  'library.errorCode': { uz: 'Kod: {code}', en: 'Code: {code}' },

  // ---------------------------------------------------------------- add a book
  'addBook.title': { uz: "Kitob qo'shish", en: 'Add a book' },
  'addBook.notice': {
    uz: "O'zbekcha matn joylang (lotin yozuvi yaxshiroq ishlaydi) yoki .txt / .md fayl tanlang. Matn serverga faqat "
      + 'ovoz yaratish uchun yuboriladi. Telefon barcha qismlarni yuklab olib tasdiqlagach, server o\'z nusxasini o\'chiradi.',
    en: 'Paste Uzbek text (Latin script works best) or load a .txt or .md file. The text is sent to the server only to '
      + 'create audio. The server deletes its copy as soon as this phone has downloaded and confirmed every part.',
  },
  'addBook.titleLabel': { uz: 'Sarlavha', en: 'Title' },
  'addBook.titlePlaceholder': { uz: 'Masalan: 1-bob', en: 'For example: Chapter 1' },
  'addBook.textLabel': { uz: 'Matn', en: 'Text' },
  'addBook.textPlaceholder': { uz: 'Matnni shu yerga joylang', en: 'Paste the text here' },
  'addBook.charCount': { uz: '{count} / {max} belgi', en: '{count} / {max} characters' },
  'addBook.cyrillicWarning': {
    uz: "Bu matnda kirill harflari bor. O'zbek ovozlari lotin yozuviga moslangan, shuning uchun ba'zi so'zlar "
      + "noto'g'ri talaffuz qilinishi mumkin.",
    en: 'This text contains Cyrillic letters. The Uzbek voices are set up for Latin script, so some words may be '
      + 'pronounced incorrectly.',
  },
  'addBook.loadFile': { uz: '.txt yoki .md fayl yuklash', en: 'Load a .txt or .md file' },
  'addBook.loadFileHint': { uz: 'Fayl tanlash oynasini ochadi', en: 'Opens the file picker' },
  'addBook.fileError': { uz: "Faylni o'qib bo'lmadi.", en: 'The file could not be read.' },
  'addBook.partLengthTitle': { uz: 'Qism uzunligi', en: 'Part length' },
  'addBook.partLengthBody': {
    uz: 'Har bir qism bir yoki ikki gapdan iborat. Qisqa qismlar tezroq boshlanadi, uzunlari tabiiyroq eshitiladi.',
    en: 'Each part is one or two sentences. Shorter parts start sooner; longer parts feel more natural.',
  },
  'addBook.sentencesLabel': { uz: 'Bir qismdagi gaplar', en: 'Sentences per part' },
  'addBook.oneSentence': { uz: '1 gap', en: '1 sentence' },
  'addBook.twoSentences': { uz: '2 gap', en: '2 sentences' },
  'addBook.create': { uz: 'Audiokitob yaratish', en: 'Create audiobook' },
  'addBook.submitError': { uz: 'Kitob yaratilmadi.', en: 'The book could not be created.' },
  'addBook.footnote': {
    uz: 'Kitob yaratish uchun internet kerak. Audio telefonga yuklangandan keyin tinglash oflayn ishlaydi.',
    en: 'Creating a book needs an internet connection. After the audio is on this phone, listening works offline.',
  },

  // ---------------------------------------------------------------- validation
  'errors.titleRequired': { uz: 'Sarlavha kiriting.', en: 'Enter a title.' },
  'errors.titleTooLong': { uz: 'Sarlavha {max} belgidan oshmasin.', en: 'Keep the title under {max} characters.' },
  'errors.transcriptRequired': { uz: 'Matn joylang yoki fayl yuklang.', en: 'Paste the text or load a file.' },
  'errors.transcriptTooLong': {
    uz: 'Matn juda uzun. Chegara — {max} belgi.',
    en: 'The text is too long. The limit is {max} characters.',
  },

  // ---------------------------------------------------------------- player
  'player.bookMissing': { uz: 'Bu kitob endi telefonda yo\'q.', en: 'This book is no longer on this phone.' },
  'player.backToLibrary': { uz: 'Kutubxonaga qaytish', en: 'Back to library' },
  'player.position': {
    uz: '{total} qismdan {index}-si · telefonda {stored} ta',
    en: 'Part {index} of {total} · {stored} on this phone',
  },
  'player.progressLabel': { uz: 'Telefondagi qismlar', en: 'Parts on this phone' },
  'player.repeat': { uz: 'Takror', en: 'Repeat' },
  'player.repeatHint': { uz: 'Joriy qismni boshidan qayta ijro etadi', en: 'Plays the current part again from the beginning' },
  'player.play': { uz: 'Ijro', en: 'Play' },
  'player.pause': { uz: 'Pauza', en: 'Pause' },
  'player.playHint': { uz: 'Ijroni boshlaydi yoki davom ettiradi', en: 'Starts or resumes playback' },
  'player.pauseHint': { uz: 'Ijroni to\'xtatadi', en: 'Pauses playback' },
  'player.next': { uz: 'Keyingi', en: 'Next' },
  'player.nextHint': { uz: 'Keyingi qismga o\'tadi', en: 'Moves to the next part' },
  'player.retryDownload': { uz: 'Yuklashni qayta urinish', en: 'Retry download' },
  'player.voiceTitle': { uz: 'Ovozli buyruqlar', en: 'Voice commands' },
  'player.lastCommand': { uz: 'Oxirgi buyruq: {command}', en: 'Last command: {command}' },
  'player.voiceOfflineHint': {
    uz: 'Internetsiz ishlaydi. Buyruqlar dinamikdan chiqmasligi uchun quloqchin ishlating yoki telefonni yaqin tuting.',
    en: 'Works offline. Use headphones, or keep the phone close, so the speaker does not trigger commands.',
  },
  'player.parts': { uz: 'Qismlar', en: 'Parts' },
  'player.partsEmpty': {
    uz: 'Server kitobni tayyorlab bo\'lgach, qismlar shu yerda ko\'rinadi.',
    en: 'Parts appear here when the server has finished preparing the book.',
  },
  'player.partLabel': { uz: '{index}-qism', en: 'Part {index}' },
  'player.partA11y': { uz: '{index}-qism, {label}', en: 'Part {index}, {label}' },
  'player.attention': { uz: 'Ijro e\'tibor talab qiladi.', en: 'Playback needs attention.' },

  // ---------------------------------------------------------------- settings
  'settings.title': { uz: 'Sozlamalar', en: 'Settings' },
  'settings.serverHeading': { uz: 'Server', en: 'Server' },
  'settings.serverHint': {
    uz: 'Reavailable serverining HTTPS manzili, masalan https://reavailable-api.sizning-hudud.workers.dev. '
      + 'Oddiy http:// faqat development versiyalarda ishlaydi.',
    en: 'The HTTPS address of your Reavailable server, for example https://reavailable-api.your-area.workers.dev. '
      + 'Plain http:// works only in development builds.',
  },
  'settings.serverAddress': { uz: 'Server manzili', en: 'Server address' },
  'settings.accessKey': { uz: 'Kirish kaliti (server so\'rasa)', en: 'Access key (only if the server asks for one)' },
  'settings.accessKeyPlaceholder': { uz: 'Ixtiyoriy', en: 'Optional' },
  'settings.test': { uz: 'Ulanishni tekshirish', en: 'Test connection' },
  'settings.connected': { uz: 'Ulandi. Server versiyasi {version}.', en: 'Connected. Server version {version}.' },
  'settings.connectedNoKey': {
    uz: 'Ulandi. Server versiyasi {version}. Bu server kirish kalitini talab qilmaydi.',
    en: 'Connected. Server version {version}. This server does not ask for an access key.',
  },
  'settings.saved': { uz: 'Saqlandi. Server: {url}', en: 'Saved. Server: {url}' },
  'settings.requestFailed': { uz: 'So\'rov bajarilmadi.', en: 'The request failed.' },
  'settings.invalidUrl': {
    uz: 'Server manzili to\'liq URL bo\'lishi kerak, masalan https://reavailable-api.example.workers.dev',
    en: 'The server address must be a full URL, for example https://reavailable-api.example.workers.dev',
  },
  'settings.connectedOld': {
    uz: 'Ulandi. Server versiyasi {version}. Bu server qisqartirilgan javob beradi, ovoz ro\'yxati ko\'rinmaydi.',
    en: 'Connected. Server version {version}. This server does not report its voices.',
  },
  'settings.keyMissing': {
    uz: 'Server javob berdi, lekin kirish kalitini so\'raydi. Kalitni kiriting.',
    en: 'The server answered, but it asks for an access key. Enter the key.',
  },
  'settings.providerWarning': {
    uz: 'Diqqat: server hozir {provider} provayderi bilan ishlayapti, haqiqiy o\'zbek ovozi emas.',
    en: 'Note: the server is running the {provider} provider, not a real Uzbek voice.',
  },
  'settings.voicesLine': {
    uz: 'Mavjud ovozlar: {voices}. Standart: {default}.',
    en: 'Available voices: {voices}. Default: {default}.',
  },
  'settings.keyRejected': {
    uz: 'Server javob berdi, lekin bu kirish kalitini qabul qilmadi. Kalitni tekshiring.',
    en: 'The server answered, but it did not accept this access key. Check the key.',
  },
  'settings.voiceHeading': { uz: 'Ovozli buyruqlar', en: 'Voice commands' },
  'settings.voiceBody': {
    uz: 'Inglizcha "next", "repeat", "pause" yoki "resume" deng. Tanish ovozli buyruqlar telefonda bajariladi va '
      + 'internetsiz ishlaydi. Mikrofon faqat ovozli buyruqlar yoqilganda ishlatiladi.',
    en: 'Say "next", "repeat", "pause" or "resume" in English. Recognition runs on this phone and works without a '
      + 'connection. The microphone is used only while voice commands are on.',
  },
  'settings.voiceUnavailable': {
    uz: 'Ovozli buyruqlar uchun nutq moduli bo\'lgan development yoki release versiya kerak. Expo Go\'da ishlamaydi.',
    en: 'Voice commands need a development or release build that includes the speech module. They are not available '
      + 'in Expo Go.',
  },
  'settings.voiceChangeError': {
    uz: 'Ovozli buyruqlarni o\'zgartirib bo\'lmadi.',
    en: 'Voice commands could not be changed.',
  },
  'settings.voiceHeadphones': {
    uz: 'Yaxshi natija uchun quloqchin ishlating. Dinamikdan chiqqan ovoz mikrofon orqali buyruq deb qabul qilinishi mumkin.',
    en: 'For best results use headphones. Speaker output can be picked up by the microphone and, in rare cases, read '
      + 'as a command.',
  },
  'settings.storageHeading': { uz: 'Xotira va maxfiylik', en: 'Storage and privacy' },
  'settings.storageBody': {
    uz: 'Audio ilovaning o\'z xotirasida, shu telefonda saqlanadi. Ilovani o\'chirsangiz yoki ma\'lumotlarini '
      + 'tozalasangiz, telefondagi barcha audio yo\'qoladi. Server audioni faqat telefon uni olganini tasdiqlaguncha '
      + 'saqlaydi, tasdiqlanmagan audioni esa belgilangan muddatdan keyin o\'chiradi. Matningiz kerak bo\'lsa, '
      + 'nusxasini saqlab qo\'ying.',
    en: 'Audio is saved in the app\'s own storage on this phone. Uninstalling the app, or clearing its data, deletes '
      + 'all audio on the phone. The server keeps audio only until this phone confirms it has the audio, and it '
      + 'removes unconfirmed audio after its retention period. Keep a copy of your text if you need one.',
  },
  'settings.storageExpiry': {
    uz: 'Server nusxasining muddati telefon barcha qismlarni olmasdan tugasa, telefonga allaqachon yuklangan qismlar saqlanadi.',
    en: 'If the server copy expires before this phone has every part, the parts already on the phone are kept.',
  },
  'settings.languageHeading': { uz: 'Til', en: 'Language' },
  'settings.languageBody': {
    uz: 'Ilova tilini tanlang. Ovozli buyruqlar har doim inglizcha: "next", "repeat", "pause", "resume".',
    en: 'Choose the language of the app. Voice commands are always English: "next", "repeat", "pause", "resume".',
  },
  'settings.languageUz': { uz: "O'zbekcha", en: 'Uzbek' },
  'settings.languageEn': { uz: 'Inglizcha', en: 'English' },
  'settings.languageLabel': { uz: 'Interfeys tili', en: 'Interface language' },

  // ---------------------------------------------------------------- status of a book
  'status.processing': { uz: 'Serverda tayyorlanmoqda', en: 'Preparing on server' },
  'status.processingDetail': {
    uz: 'Server audio yaratmoqda. Tayyor bo\'lgach shu yerga yuklab olinadi.',
    en: 'The server is generating the audio. It will download here when it is ready.',
  },
  'status.downloading': { uz: 'Yuklab olinmoqda', en: 'Downloading' },
  'status.partsOnPhone': {
    uz: '{total} qismdan {stored} tasi shu telefonda.',
    en: '{stored} of {total} parts on this phone.',
  },
  'status.readyOffline': { uz: 'Oflayn tayyor', en: 'Ready offline' },
  'status.readyAllParts': {
    uz: 'Barcha {total} qism shu telefonda va endi internet kerak emas.',
    en: 'All {total} parts are on this phone and do not need a connection.',
  },
  'status.readyExpired': {
    uz: 'Barcha {total} qism shu telefonda. Serverdagi nusxaning muddati allaqachon tugagan edi.',
    en: 'All {total} parts are on this phone. The server copy had already expired.',
  },
  'status.readyFinishing': { uz: 'Tayyor, sinxronlash yakunlanmoqda', en: 'Ready, finishing sync' },
  'status.readyFinishingDetail': {
    uz: 'Server bilan sinxronlash yakunlanmoqda. Shu vaqtda audio odatdagidek ijro etiladi.',
    en: 'Finishing the sync with the server. Audio plays normally meanwhile.',
  },
  'status.failed': { uz: 'Xato', en: 'Failed' },
  'status.failedDetail': { uz: 'Nimadir xato ketdi. Qayta urinib ko\'ring.', en: 'Something went wrong. Try again.' },

  // ---------------------------------------------------------------- status of a part
  'part.waiting': { uz: 'Kutilmoqda', en: 'Waiting' },
  'part.stored': { uz: 'Telefonda', en: 'On phone' },
  'part.storedSyncing': { uz: 'Telefonda, sinxronlanmoqda', en: 'On phone, syncing' },
  'part.downloading': { uz: 'Yuklab olinmoqda', en: 'Downloading' },
  'part.lost': { uz: "Yo'qolgan", en: 'Lost' },
  'part.retrying': { uz: 'Qayta urilmoqda', en: 'Retrying' },

  // ---------------------------------------------------------------- playback messages
  'playback.idle': {
    uz: 'Tinglashni boshlash uchun kutubxonadan kitob tanlang.',
    en: 'Choose a book in the library to start listening.',
  },
  'playback.playing': {
    uz: '{total} qismdan {index}-si ijro etilmoqda.',
    en: 'Playing part {index} of {total}.',
  },
  'playback.paused': {
    uz: '{total} qismdan {index}-sisida to\'xtatildi.',
    en: 'Paused at part {index} of {total}.',
  },
  'playback.finished': {
    uz: 'Tugadi. Qayta tinglash uchun Ijro tugmasini bosing yoki "repeat" deng.',
    en: 'Finished. Press Play or say "repeat" to listen again.',
  },
  'playback.waitingProcessing': {
    uz: 'Server bu kitobni hali tayyorlamoqda. Ijro birinchi qism telefonga yuklangach boshlanadi.',
    en: 'The server is still preparing this book. Playback starts when the first part is on this phone.',
  },
  'playback.waitingMissing': {
    uz: '{index}-qism yuklab olinmadi. O\'tkazib yuborish uchun Keyingi tugmasini bosing yoki kutubxonadan qayta urinib ko\'ring.',
    en: 'Part {index} could not be downloaded. Press Next to skip it, or retry from the library.',
  },
  'playback.waitingDownload': {
    uz: '{index}-qism hali yuklab olinmoqda. Ijro avtomatik boshlanadi.',
    en: 'Part {index} is still downloading. Playback starts automatically.',
  },
  'playback.error': { uz: 'Ijro etilmadi. Qayta urinib ko\'ring.', en: 'Playback failed. Try again.' },

  // ---------------------------------------------------------------- voice control messages
  'voice.off': {
    uz: 'Ovozli buyruqlar o\'chirilgan. Sozlamalardan yoqishingiz mumkin.',
    en: 'Voice commands are off. Turn them on in Settings.',
  },
  'voice.starting': { uz: 'Ovozli buyruqlar ishga tushmoqda…', en: 'Starting voice commands…' },
  'voice.listening': {
    uz: 'Tinglanmoqda. "next", "repeat", "pause" yoki "resume" deng.',
    en: 'Listening. Say "next", "repeat", "pause" or "resume".',
  },
  'voice.unavailableBuild': {
    uz: 'Oflayn ovozli boshqaruv bu versiyada ishlamaydi. Buning uchun nutq moduli bo\'lgan development versiya '
      + 'kerak (Expo Go emas).',
    en: 'Offline voice control is not available in this build. It needs a development build that includes the speech '
      + 'module (not Expo Go).',
  },
  'voice.stopped': { uz: 'Ovozli buyruqlar to\'xtadi.', en: 'Voice commands stopped.' },
  'voice.stoppedWith': {
    uz: 'Ovozli buyruqlar to\'xtadi: {message}',
    en: 'Voice commands stopped: {message}',
  },

  // ---------------------------------------------------------------- app level
  'app.serverNeeded': {
    uz: 'Avval Sozlamalarda server manzilini kiriting.',
    en: 'Set the server address in Settings first.',
  },
  'app.removeFailed': { uz: 'Kitobni o\'chirib bo\'lmadi', en: 'The book could not be removed' },
  'app.tryAgain': { uz: 'Qayta urinib ko\'ring.', en: 'Try again.' },

  // ---------------------------------------------------------------- sync notes
  'sync.connection': {
    uz: 'Ulanish kutilmoqda. Yuklash avtomatik davom etadi.',
    en: 'Waiting for a connection. Downloads resume automatically.',
  },
  'sync.partsMissing': {
    uz: "Ba'zi qismlar hali yetishmayapti. Yuklash avtomatik davom etadi.",
    en: 'Some parts are still missing. Downloads resume automatically.',
  },

  // ---------------------------------------------------------------- server error codes
  'error.tts_auth_failed': {
    uz: 'Nutq xizmati server kalitlarini qabul qilmadi. Server sozlamasini to\'g\'rilash kerak.',
    en: 'The speech service rejected its credentials. The server operator must fix the configuration.',
  },
  'error.tts_bad_request': {
    uz: 'Nutq xizmati bu matnning bir qismini rad etdi. Kitobni tahrirlab qayta yarating.',
    en: 'The speech service rejected part of this text. Edit the book and create it again.',
  },
  'error.tts_unavailable': {
    uz: 'Nutq xizmati vaqtincha ishlamayapti. Bir necha daqiqadan so\'ng qayta urinib ko\'ring.',
    en: 'The speech service is temporarily unavailable. Retry in a few minutes.',
  },
  'error.internal_error': {
    uz: 'Serverda kutilmagan xato yuz berdi. Keyinroq qayta urinib ko\'ring.',
    en: 'The server hit an unexpected error. Retry later.',
  },
  'error.server_misconfigured': {
    uz: 'Server to\'liq sozlanmagan (nutq xizmati kaliti yo\'q). Server egasi sozlamani to\'g\'rilashi kerak.',
    en: 'The server is not fully configured (its speech key is missing). The operator has to fix the settings.',
  },
  'error.job_not_found': {
    uz: 'Serverdagi nusxa muddati tugagan yoki o\'chirilgan. Telefonga yuklangan qismlar saqlanadi.',
    en: 'The server copy has expired or was removed before this device had every part. Parts already on this device '
      + 'are kept.',
  },
  'error.chunk_unavailable': {
    uz: 'Bir qism serverda endi mavjud emas. Telefonga yuklangan qismlar saqlanadi.',
    en: 'A part is no longer available on the server. Parts already on this device are kept.',
  },
  'error.chunk_not_found': {
    uz: 'Bir qism serverda endi mavjud emas. Telefonga yuklangan qismlar saqlanadi.',
    en: 'A part is no longer available on the server. Parts already on this device are kept.',
  },
  'error.chunk_not_ready': {
    uz: 'Server bu qismni hali tayyorlamoqda. Yuklash avtomatik davom etadi.',
    en: 'The server is still finishing this part. Downloads resume automatically.',
  },
  'error.unauthorized': {
    uz: 'Server bu kitobning kirish tokenini rad etdi.',
    en: 'The server rejected the access token for this book.',
  },
  'error.checksum_mismatch': {
    uz: 'Yuklangan qism tekshiruvdan o\'tmadi va qayta yuklab olinadi.',
    en: 'A downloaded part failed verification and will be downloaded again.',
  },
  'error.checksum_rejected': {
    uz: 'Server qismni tekshiruvi mos kelmagani uchun qayta-qayta rad etmoqda. Qayta yuklab ko\'ring yoki kitobni o\'chiring.',
    en: 'The server keeps rejecting a part because its checksum does not match. Retry to download it again, or remove '
      + 'the book.',
  },
  'error.network': {
    uz: 'Server bilan aloqa yo\'q. Yuklash avtomatik davom etadi.',
    en: 'No connection to the server. Downloads resume automatically.',
  },
  'error.timeout': {
    uz: 'Server javob berishga kechikdi. Yuklash avtomatik davom etadi.',
    en: 'The server took too long to respond. Downloads resume automatically.',
  },
  'error.invalid_response': {
    uz: 'Server kutilmagan javob qaytardi.',
    en: 'The server returned an unexpected response.',
  },
  'error.job_not_ready': { uz: 'Kitob serverda hali tayyor emas.', en: 'The book is not ready on the server yet.' },
  'error.token_missing': {
    uz: 'Bu kitobning kirish tokeni telefonda yo\'q.',
    en: 'The access token for this book is missing on this device.',
  },
  'error.storage_failed': {
    uz: 'Audioni telefonga saqlab bo\'lmadi. Xotirada joy bo\'shating, so\'ng qayta urinib ko\'ring.',
    en: 'The audio could not be saved on this device. Free up storage space, then retry.',
  },
  'error.file_missing': {
    uz: 'Ba\'zi qismlar telefondan o\'chib ketgan va tiklanmaydi. Kitobni o\'chirib qaytadan qo\'shing.',
    en: 'Some parts were removed from this device and cannot be recovered. Remove the book and add it again.',
  },
  'error.invalid_title': {
    uz: 'Sarlavha noto\'g\'ri. U 1 dan 200 belgigacha bo\'lishi kerak.',
    en: 'The title is not valid. It must be 1 to 200 characters.',
  },
  'error.empty_transcript': {
    uz: 'Matn bo\'sh yoki unda gap yo\'q. Kitob matnini tekshiring.',
    en: 'The text is empty or has no sentences. Check the book text.',
  },
  'error.transcript_too_long': {
    uz: 'Matn juda uzun. Uni bir necha kitobga bo\'ling.',
    en: 'The text is too long. Split it into several books.',
  },
  'error.too_many_chunks': {
    uz: 'Matn juda ko\'p qismga bo\'linadi. Uni qisqartiring.',
    en: 'The text splits into too many parts. Make it shorter.',
  },
  'error.unsupported_voice': {
    uz: 'Bu ovoz serverda yoqilmagan. Boshqa ovoz tanlang.',
    en: 'This voice is not enabled on the server. Choose another voice.',
  },
  'error.invalid_sentences_per_chunk': {
    uz: 'Qism uzunligi noto\'g\'ri tanlandi. 1 yoki 2 gapni tanlang.',
    en: 'The part length is not valid. Choose 1 or 2 sentences.',
  },
  'error.payload_too_large': {
    uz: 'So\'rov juda katta. Matnni qisqartiring.',
    en: 'The request is too large. Make the text shorter.',
  },
  'error.job_not_failed': {
    uz: 'Bu kitobni qayta urintirib bo\'lmaydi: u xato holatida emas.',
    en: 'This book cannot be retried: it is not in a failed state.',
  },
  'error.validation_failed': {
    uz: 'Server so\'rovni qabul qilmadi. Maydonlarni tekshiring.',
    en: 'The server rejected the request. Check the fields.',
  },
  'error.not_found': { uz: 'So\'ralgan narsa topilmadi.', en: 'The requested item was not found.' },
  'error.file_wrong_type': {
    uz: 'Faqat .txt yoki .md faylni tanlang.',
    en: 'Choose a .txt or .md file.',
  },
  'error.file_too_large': {
    uz: 'Fayl 1 MB dan katta. Uni bir necha kitobga bo\'ling.',
    en: 'The file is larger than 1 MB. Split it into several books.',
  },
  'error.fallback': { uz: 'Nimadir xato ketdi. Qayta urinib ko\'ring.', en: 'Something went wrong. Try again.' },
} as const;

export type StringKey = keyof typeof STRINGS;
