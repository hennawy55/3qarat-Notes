# دفتر العقارات الذكي — SmartNote

## قاعدة البيانات
الواجهة تستخدم Supabase Edge Function `smartnote-auth` بدل Google Apps Script وGoogle Sheets. ملف `Code.gs` محفوظ كمرجع للنسخة القديمة، لكنه لم يعد endpoint نشطًا في الواجهة.

## إعداد Supabase
1. افتح SQL Editor في مشروع Supabase وشغّل ملفات `supabase/migrations` بالترتيب من 001 إلى 006. لا تتجاوز migration؛ الملفات تعتمد على بعضها.
2. من Project Settings → Edge Functions → Secrets أضف:
   - `SUPABASE_URL`: رابط المشروع.
   - `SUPABASE_SERVICE_ROLE_KEY`: مفتاح service role، يبقى داخل Edge Function فقط.
   - `SMARTNOTE_BOOTSTRAP_SECRET`: كلمة سر عشوائية مؤقتة لإنشاء المدير الأول.
3. انشر الدالة من جذر المستودع باستخدام Supabase CLI:
   ```bash
   supabase functions deploy smartnote-auth
   ```
   ملف `supabase/config.toml` يعطل JWT verification على مستوى البوابة لأن التطبيق يستخدم جلسات مخصصة تتحقق منها الدالة نفسها.
4. أنشئ أول مدير بطلب `bootstrap_admin` مع Header `x-smartnote-bootstrap` مطابق للسر المؤقت. استخدم اسم مستخدم من 3 إلى 40 حرفًا لاتينيًا/رقميًا، وكلمة مرور قوية لا تقل عن 10 أحرف. بعد نجاح الإنشاء احذف `SMARTNOTE_BOOTSTRAP_SECRET` من Secrets.
5. يحتوي `app.js` على Project URL ومفتاح publishable فقط. لا تضع `service_role` في HTML أو JavaScript أو APK مطلقًا.

مثال طلب إنشاء المدير (استبدل القيم محليًا ولا تضع السر في المستودع):
```bash
curl -X POST "$SUPABASE_URL/functions/v1/smartnote-auth" \
  -H "apikey: $SUPABASE_PUBLISHABLE_KEY" \
  -H "Content-Type: application/json" \
  -H "x-smartnote-bootstrap: $SMARTNOTE_BOOTSTRAP_SECRET" \
  -d '{"action":"bootstrap_admin","username":"admin","password":"REPLACE_WITH_STRONG_PASSWORD"}'
```

## ما الذي يتم تخزينه؟
- بيانات الحسابات المخصصة وكلمات المرور المشتقة والجلسات تُدار في جداول منفصلة؛ لا يعتمد تسجيل الدخول على Supabase Auth.
- بيانات المساحات والمشروعات والوحدات والعملاء والملاحظات والمتابعات الأساسية تحفظ في جداول المستخدم المخصصة.
- المتابعات الموجهة، سجل الحركة، طلبات إعادة الإسناد، الملاحظات الخاصة/المشتركة، والإشعارات تحفظ في جداولها.
- استبدال قاعدة بيانات المستخدم عملية ذرية، مع رقم revision لاكتشاف تعارض تعديلات الأجهزة المختلفة.
- تظل بيانات Google Sheets القديمة دون حذف. الـ migrations تنشئ البنية الجديدة ولا تستورد سجلات Sheets تلقائيًا؛ يلزم تنفيذ استيراد منفصل قبل اعتبار النقل التاريخي مكتملًا.

## بناء نسخة الويب
```bash
npm install
npm run test:smoke
npm run prepare:web
```
انشر محتويات `web-build/` على استضافة HTTPS. خطوة التحضير تنسخ Lucide محليًا مع ملفات الواجهة والأيقونات، ولا تعتمد نسخة الويب على CDN للأيقونات.

## بناء APK
```bash
npm install
npm run test:smoke
npm run prepare:android
npx cap sync android
npx cap open android
```
بعد فتح Android Studio اختر Build → Build Bundle(s) / APK(s) → Build APK(s). ملف debug الناتج يكون داخل `android/app/build/outputs/apk/debug/`.

## الأيقونات والإشعارات
- Lucide مثبت على الإصدار 0.468.0 ويُنسخ محليًا إلى بناء الويب وAndroid.
- أيقونة التطبيق هي `icons/smartnote-icon.svg`.
- إشعارات المتابعات داخل التطبيق تُخزن في Supabase. توصيل إشعارات push بعد إغلاق التطبيق يحتاج FCM أو خدمة إشعارات أصلية منفصلة؛ لا تعتبر polling داخل التطبيق بديلًا عن ذلك.
