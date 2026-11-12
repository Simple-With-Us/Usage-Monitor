"use client";

import { useState, useEffect } from "react";
import { Bell, Mail, Smartphone, ShieldAlert, CheckCircle, AlertTriangle } from "lucide-react";

interface NotificationSettings {
  pushoverConfigured: boolean;
  emailConfigured: boolean;
  slackConfigured: boolean;
  pagerdutyConfigured: boolean;
  apnsConfigured?: boolean;
  activeApnsDeviceCount: number;
  minSeverity: "info" | "warning" | "critical";
  reminderHours: number;
}

export default function NotificationsSettingsPanel() {
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Form states
  const [emailEnabled, setEmailEnabled] = useState(true);
  const [minSeverity, setMinSeverity] = useState<"info" | "warning" | "critical">("warning");
  const [pushoverUserKey, setPushoverUserKey] = useState("");
  const [pushoverApiToken, setPushoverApiToken] = useState("");

  useEffect(() => {
    async function loadSettings() {
      try {
        setLoading(true);
        const res = await fetch("/api/settings");
        if (res.ok) {
          const data = await res.json();
          setSettings(data.notifications);
          setEmailEnabled(data.notifications.emailConfigured);
          setMinSeverity(data.notifications.minSeverity || "warning");
        }
      } catch (err) {
        console.error("Failed to load notification settings", err);
      } finally {
        setLoading(false);
      }
    }
    void loadSettings();
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMessage(null);

    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          emailEnabled,
          minSeverity,
          ...(pushoverUserKey.trim() ? { pushoverUserKey: pushoverUserKey.trim() } : {}),
          ...(pushoverApiToken.trim() ? { pushoverApiToken: pushoverApiToken.trim() } : {}),
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setSettings((prev) => (prev ? { ...prev, ...data.notifications } : null));
        setMessage({ type: "success", text: "Notification settings updated successfully." });
        setPushoverUserKey("");
        setPushoverApiToken("");
      } else {
        const err = await res.json();
        throw new Error(err.error || "Failed to update settings");
      }
    } catch (err) {
      setMessage({ type: "error", text: err instanceof Error ? err.message : "Save failed" });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-6 text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
        Loading notification settings...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-800">
        <h2 className="flex items-center gap-2 text-base font-semibold text-gray-900 dark:text-gray-100">
          <Bell className="h-5 w-5 text-blue-500" />
          Notification Channels & Alert Delivery
        </h2>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Configure external alert channels (Pushover, APNs, Email, Slack, PagerDuty) and severity thresholds.
          Server-side delivery (Slack/email/Pushover/PagerDuty) runs on the monitor host. Native iOS remote push
          requires the app to register a device token with a valid session; local/background alerts on device
          still need a read token configured in the iOS app.
        </p>

        {message && (
          <div
            className={`mt-4 flex items-center gap-2 rounded-lg p-3 text-sm ${
              message.type === "success"
                ? "bg-green-50 text-green-700 dark:bg-green-950/30 dark:text-green-300"
                : "bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300"
            }`}
          >
            {message.type === "success" ? <CheckCircle className="h-4 w-4 shrink-0" /> : <AlertTriangle className="h-4 w-4 shrink-0" />}
            {message.text}
          </div>
        )}

        <form onSubmit={handleSave} className="mt-6 space-y-6">
          {/* Active Channels Status Grid */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-700 dark:bg-gray-800/50">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase text-gray-500 dark:text-gray-400 flex items-center gap-1.5">
                  <Smartphone className="h-4 w-4" /> Pushover
                </span>
                <span
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                    settings?.pushoverConfigured
                      ? "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300"
                      : "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300"
                  }`}
                >
                  {settings?.pushoverConfigured ? "Active" : "Not Set"}
                </span>
              </div>
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                Primary push notifications for urgent alerts.
              </p>
            </div>

            <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-700 dark:bg-gray-800/50">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase text-gray-500 dark:text-gray-400 flex items-center gap-1.5">
                  <Smartphone className="h-4 w-4 text-purple-500" /> APNs Native Push
                </span>
                <span
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                    (settings?.activeApnsDeviceCount ?? 0) > 0
                      ? "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300"
                      : "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300"
                  }`}
                >
                  {settings?.apnsConfigured
                    ? (settings.activeApnsDeviceCount ?? 0) > 0
                      ? `${settings.activeApnsDeviceCount} Devices`
                      : "Configured"
                    : (settings?.activeApnsDeviceCount ?? 0) > 0
                      ? `${settings?.activeApnsDeviceCount} Devices, sender not configured`
                      : "Not configured"}
                </span>
              </div>
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                Native iPhone alerts for the same budget and provider pages that go to Pushover.
                Devices register from the iOS app Settings → Notifications.  The server sends only
                when APNS_KEY_ID / APNS_TEAM_ID / APNS_BUNDLE_ID / APNS_P8 are set in Infisical.
              </p>
            </div>

            <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-700 dark:bg-gray-800/50">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase text-gray-500 dark:text-gray-400 flex items-center gap-1.5">
                  <Mail className="h-4 w-4" /> Email Alerts
                </span>
                <span
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                    emailEnabled && settings?.emailConfigured
                      ? "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300"
                      : "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                  }`}
                >
                  {emailEnabled && settings?.emailConfigured ? "Enabled" : "Disabled"}
                </span>
              </div>
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                Resend transactional email notifications.
              </p>
            </div>

            <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-700 dark:bg-gray-800/50">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase text-gray-500 dark:text-gray-400 flex items-center gap-1.5">
                  <ShieldAlert className="h-4 w-4" /> Min Severity
                </span>
                <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium capitalize text-gray-800 dark:bg-gray-700 dark:text-gray-200">
                  {minSeverity}
                </span>
              </div>
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                Minimum alert level sent to external channels.
              </p>
            </div>
          </div>

          {/* Email Controls */}
          <div className="space-y-3 pt-2">
            <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">Email Delivery Controls</h3>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={emailEnabled}
                onChange={(e) => setEmailEnabled(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700"
              />
              <span className="text-sm text-gray-700 dark:text-gray-300">
                Enable email notifications (uncheck to stop receiving emails and rely on Pushover / APNs)
              </span>
            </label>
          </div>

          {/* Minimum Severity Selector */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-gray-900 dark:text-gray-100">
              Minimum External Alert Severity Threshold
            </label>
            <select
              value={minSeverity}
              onChange={(e) => setMinSeverity(e.target.value as any)}
              className="w-full max-w-xs rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
            >
              <option value="warning">Warning & Critical (Default)</option>
              <option value="critical">Critical Only (High urgency budget breaches only)</option>
              <option value="info">All Alerts including Info</option>
            </select>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Pollable providers refresh quietly on a schedule (at least hourly). Never-pollable sources are labeled Manual, not stale.
            </p>
          </div>

          {/* Pushover Credentials Update */}
          <div className="space-y-4 rounded-lg border border-gray-100 bg-gray-50 p-4 dark:border-gray-700/60 dark:bg-gray-900/40">
            <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">Pushover Credentials</h3>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Pushover User Key</label>
                <input
                  type="password"
                  placeholder={settings?.pushoverConfigured ? "••••••••••••••••" : "User Key"}
                  value={pushoverUserKey}
                  onChange={(e) => setPushoverUserKey(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Pushover Application API Token</label>
                <input
                  type="password"
                  placeholder={settings?.pushoverConfigured ? "••••••••••••••••" : "API Token"}
                  value={pushoverApiToken}
                  onChange={(e) => setPushoverApiToken(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
                />
              </div>
            </div>
          </div>

          <div className="pt-2">
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save Notification Settings"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
