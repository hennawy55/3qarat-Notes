# SmartNote Android (Capacitor)

نسخة Android تتصل بـ Supabase من خلال Edge Function `smartnote-auth`. يوجد داخل الواجهة رابط المشروع ومفتاح publishable العام فقط؛ يجب إبقاء `SUPABASE_SERVICE_ROLE_KEY` داخل Edge Function Secrets.

## متطلبات البناء
Node.js 22 أو أحدث، JDK 17/21، Android Studio وAndroid SDK.

```bash
npm install
npm run test:smoke
npm run prepare:android
npx cap sync android
npx cap open android
```

من Android Studio اختر Build → Build Bundle(s) / APK(s) → Build APK(s). ملف debug يظهر في `android/app/build/outputs/apk/debug/app-debug.apk`.

Lucide 0.468.0 مضمّن محليًا في APK. أيقونة التطبيق: `icons/smartnote-icon.svg`. لا تضع مفتاح service role داخل APK.
