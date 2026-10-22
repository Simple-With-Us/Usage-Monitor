# 2026-10-09 — Explicit iOS bundle identifiers

The 2026-09-23 scheme omitted the platform suffix from the Client and Local app IDs.  The owner approved adding `.ios` so Usage follows the explicit platform naming used by the Safari targets and leaves room for a future Mac client.

## Active identifiers

| Target | Bundle ID | Apple registration |
|---|---|---|
| Usage Monitor app | `com.simplewithus.usage.client.ios` | Explicit App ID; App Groups + Push Notifications |
| Usage Monitor widget extension | `com.simplewithus.usage.client.ios.widget` | Explicit App ID; App Groups |
| Local Monitor app | `com.simplewithus.usage.local.ios` | Explicit App ID; App Groups |
| Usage Monitor app tests | `com.simplewithus.usage.client.ios.tests` | Test bundle nested under Client |
| Widget tests | `com.simplewithus.usage.client.ios.widgettests` | Test bundle nested under Client |

The shared group remains `group.com.simplewithus.usage`.  Safari, macOS, server, and web identifiers are unchanged.  URL schemes (`usageclientmonitor://` and `usagelocalmonitor://`) remain unchanged; the bundle-qualified URL type names, APNs topic, and background task identifier use the new IDs.

## Registering the widget in Apple Developer

The widget is an extension inside the Usage Monitor app.  Register its explicit App ID in Apple Developer; do not create a separate App Store Connect app record for the widget.

1. Sign in with an **Account Holder** or **Admin** role.  In [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/identifiers/list), open **Identifiers** and choose **+**.
2. Select **App IDs**, then **App**.  Choose **Explicit App ID** and enter `com.simplewithus.usage.client.ios.widget` exactly.
3. Enable **App Groups**, configure it, select `group.com.simplewithus.usage`, and register the ID.  If that group is not listed, create it under **App Groups** first, then assign it to the App ID.
4. Ensure the host App ID `com.simplewithus.usage.client.ios` is also registered with **App Groups** assigned to the same group and **Push Notifications** enabled.  Register `com.simplewithus.usage.local.ios` with the same App Group for the Local app.
5. In App Store Connect, create records for the Client and Local host apps only.  The widget extension is delivered inside the Client app build.

Apple's portal requires the explicit App ID to match the Xcode target bundle identifier and capability list.  App Group association is configured on each App ID after registering the group; see Apple's [Register an App ID](https://developer.apple.com/help/account/identifiers/register-an-app-id) and [Enable app capabilities](https://developer.apple.com/help/account/identifiers/enable-app-capabilities/) instructions.

After Apple registrations and the two host app records exist, update `scripts/ios-fleet/apps.json` with the new Client and Local Apple IDs, remove `ascRecordPending`, update the ASC listing IDs, and refresh the fleet pin with `bash scripts/ios-fleet-pin.sh --update`.  Set production `APNS_BUNDLE_ID=com.simplewithus.usage.client.ios` only when a build with that ID is installed and registering device tokens.  Then run the hosted iOS ship workflow.

## Implementation

XcodeGen source is `ios/UsageMonitor/project.yml`; the checked-in Xcode project is regenerated from it.  The migration updates project targets, extension/test IDs, APNs topic defaults and tests, Info.plist URL-type and background-task identifiers, fleet app config, active docs, and the registration blocker issue.  App Group membership and URL schemes remain unchanged.

The 2026-09-23 rollout is preserved as history and marked superseded for the identifier scheme only.  Its other fixes remain applicable.
