import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { PushNotifications } from '@capacitor/push-notifications';
import { StatusBar, Style } from '@capacitor/status-bar';

const isNative = Capacitor.isNativePlatform();
const isEnglish = (() => { try { return localStorage.getItem('aqarLanguage') === 'en'; } catch { return false; } })();
let channelReady = false;
let lastScheduleSignature = '';

function stableId(value) {
  let hash = 2166136261;
  for (let i = 0; i < String(value).length; i++) {
    hash ^= String(value).charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 2147483646 + 1;
}

function parseLocalDate(date, time = '09:00') {
  if (!date) return null;
  const [year, month, day] = String(date).split('-').map(Number);
  const [hour, minute] = String(time || '09:00').split(':').map(Number);
  const value = new Date(year, month - 1, day, hour || 0, minute || 0, 0, 0);
  return Number.isNaN(value.getTime()) ? null : value;
}

async function ensureChannel() {
  if (!isNative || channelReady) return;
  try {
    await LocalNotifications.createChannel({
      id: 'smartnote-reminders',
      name: isEnglish ? 'SmartNote reminders' : 'تذكيرات SmartNote',
      description: isEnglish ? 'Follow-up due date alerts' : 'تنبيهات مواعيد المتابعات',
      importance: 5,
      visibility: 1,
      sound: 'default'
    });
  } catch (error) {
    // Android versions below API 26 do not require notification channels.
    console.debug('Notification channel setup:', error);
  }
  channelReady = true;
}

async function hasPermission(request = false) {
  if (!isNative) return false;
  const status = await LocalNotifications.checkPermissions();
  if (status.display === 'granted') return true;
  if (!request) return false;
  const requested = await LocalNotifications.requestPermissions();
  return requested.display === 'granted';
}

if (isNative) {
  // Keep Android status/navigation bars visible and reserve their layout space.
  StatusBar.setOverlaysWebView({ overlay: false }).catch(() => {});
  StatusBar.setBackgroundColor({ color: '#762236' }).catch(() => {});
  StatusBar.setStyle({ style: Style.Light }).catch(() => {});
  StatusBar.show().catch(() => {});

  window.smartNoteNativeNotifications = {
    isNative: true,

    async getPermissionStatus() {
      const status = await LocalNotifications.checkPermissions();
      return status.display === 'granted' ? 'granted' : status.display;
    },

    async registerForPushNotifications() {
      const diagnostic = { stage: 'permission_check', at: new Date().toISOString() };
      const saveDiagnostic = value => {
        try { localStorage.setItem('smartnote_fcm_diagnostics', JSON.stringify(value)); } catch {}
      };
      try {
        let push = await PushNotifications.checkPermissions();
        diagnostic.permissionBefore = push?.receive || 'unknown';
        if (push.receive !== 'granted') {
          diagnostic.stage = 'permission_request';
          push = await PushNotifications.requestPermissions();
        }
        diagnostic.permissionAfter = push?.receive || 'unknown';
        if (push.receive !== 'granted') {
          diagnostic.stage = 'permission_denied';
          saveDiagnostic(diagnostic);
          window.dispatchEvent(new CustomEvent('smartnote-fcm-diagnostic', { detail: diagnostic }));
          return false;
        }
        diagnostic.stage = 'register_called';
        saveDiagnostic(diagnostic);
        await PushNotifications.register();
        // The registration event is asynchronous; do not interpret register() resolution as a token.
        return true;
      } catch (error) {
        diagnostic.stage = 'register_exception';
        diagnostic.error = String(error?.message || error);
        saveDiagnostic(diagnostic);
        console.error('[SmartNote FCM] register() failed:', error);
        window.dispatchEvent(new CustomEvent('smartnote-fcm-diagnostic', { detail: diagnostic }));
        return false;
      }
    },
    async requestPermission() {
      const granted = await hasPermission(true);
      if (granted) await ensureChannel();
      await this.registerForPushNotifications();
      return granted;
    },

    async showInstantNotification({ id, title, body, assignmentId = '', notificationId = '' } = {}) {
      if (!(await hasPermission(false))) return;
      await ensureChannel();
      const notificationIdNumber = stableId('server:' + (id || notificationId || Date.now()));
      await LocalNotifications.schedule({
        notifications: [{
          id: notificationIdNumber,
          title: String(title || (isEnglish ? 'New notification' : 'إشعار جديد')).slice(0, 120),
          body: String(body || '').slice(0, 500),
          schedule: { at: new Date(Date.now() + 1000) },
          channelId: 'smartnote-reminders',
          smallIcon: 'ic_launcher',
          extra: { smartNoteServerNotification: true, assignmentId, notificationId }
        }]
      });
    },

    async syncTaskReminders(tasks = []) {
      if (!(await hasPermission(false))) return;
      await ensureChannel();

      const now = Date.now();
      const desired = [];
      for (const task of tasks) {
        if (!task || task.status === 'مكتملة') continue;

        if (task.dueDate) {
          const dueAt = parseLocalDate(task.dueDate, task.dueTime || '09:00');
          if (dueAt && dueAt.getTime() > now + 5000 && task.status !== 'قيد التنفيذ') {
            desired.push({
              id: stableId(task.id + ':due'),
              title: isEnglish ? 'Follow-up due' : 'موعد متابعة مستحق',
              body: (isEnglish ? 'Follow-up due: ' : 'حان موعد المتابعة: ') + (task.title || (isEnglish ? 'New follow-up' : 'متابعة جديدة')),
              schedule: { at: dueAt },
              channelId: 'smartnote-reminders',
              extra: { smartNoteReminder: true, taskId: task.id, kind: 'due', key: task.id + ':due:' + dueAt.getTime() }
            });
          }
        }

        if (task.status === 'قيد التنفيذ' && task.startedAt) {
          const startedAt = new Date(task.startedAt);
          const reminderAt = new Date(startedAt.getTime() + 60 * 60 * 1000);
          if (!Number.isNaN(reminderAt.getTime()) && reminderAt.getTime() > now + 5000) {
            desired.push({
              id: stableId(task.id + ':in_progress'),
              title: isEnglish ? 'In-progress follow-up reminder' : 'تذكير بمتابعة قيد التنفيذ',
              body: (isEnglish ? 'One hour since starting: ' : 'مرّت ساعة على بدء: ') + (task.title || (isEnglish ? 'Follow-up' : 'متابعة')),
              schedule: { at: reminderAt },
              channelId: 'smartnote-reminders',
              smallIcon: 'ic_launcher',
              extra: { smartNoteReminder: true, taskId: task.id, kind: 'in_progress', key: task.id + ':in_progress:' + task.startedAt }
            });
          }
        }
      }

      desired.sort((a, b) => a.schedule.at.getTime() - b.schedule.at.getTime());
      const bounded = desired.slice(0, 100);
      const signature = JSON.stringify(bounded.map(item => [item.id, item.schedule.at.getTime(), item.title, item.body]));
      if (signature === lastScheduleSignature) return;

      const pending = await LocalNotifications.getPending();
      const previous = (pending.notifications || []).filter(item => item.extra?.smartNoteReminder);
      if (previous.length) {
        await LocalNotifications.cancel({ notifications: previous.map(item => ({ id: item.id })) });
      }
      if (bounded.length) {
        await LocalNotifications.schedule({ notifications: bounded });
      }
      lastScheduleSignature = signature;
    },

    async cancel(id) {
      if (!isNative) return;
      const pending = await LocalNotifications.getPending();
      if ((pending.notifications || []).some(item => item.id === id)) {
        await LocalNotifications.cancel({ notifications: [{ id }] });
      }
    }
  };

  PushNotifications.addListener('registration', token => {
    const diagnostic = { stage: 'token_received', tokenLength: String(token?.value || '').length, at: new Date().toISOString() };
    try {
      localStorage.setItem('smartnote_fcm_token', token.value);
      localStorage.setItem('smartnote_fcm_diagnostics', JSON.stringify(diagnostic));
    } catch {}
    console.info('[SmartNote FCM] Token received; length:', diagnostic.tokenLength);
    window.dispatchEvent(new CustomEvent('smartnote-fcm-token', { detail: { token: token.value } }));
  });
  PushNotifications.addListener('registrationError', error => {
    const diagnostic = { stage: 'registration_error', error: String(error?.error || error?.message || JSON.stringify(error)), at: new Date().toISOString() };
    try { localStorage.setItem('smartnote_fcm_diagnostics', JSON.stringify(diagnostic)); } catch {}
    console.error('[SmartNote FCM] registrationError:', error);
    window.dispatchEvent(new CustomEvent('smartnote-fcm-diagnostic', { detail: diagnostic }));
  });
  PushNotifications.addListener('pushNotificationReceived', notification => {
    window.dispatchEvent(new CustomEvent('smartnote-push-received', { detail: notification }));
  });
  PushNotifications.addListener('pushNotificationActionPerformed', event => {
    const assignmentId = event.notification?.data?.assignmentId;
    if (typeof assignmentId === 'string' && assignmentId) window.dispatchEvent(new CustomEvent('smartnote-open-assignment', { detail: { assignmentId } }));
  });

  LocalNotifications.addListener('localNotificationActionPerformed', event => {
    const extra = event.notification?.extra || {};
    const taskId = extra.taskId;
    if (typeof taskId === 'string') {
      window.dispatchEvent(new CustomEvent('smartnote-open-task', { detail: { taskId, key: extra.key } }));
    }
    if (typeof extra.assignmentId === 'string' && extra.assignmentId) {
      window.dispatchEvent(new CustomEvent('smartnote-open-assignment', { detail: { assignmentId: extra.assignmentId } }));
    }
  });
}
