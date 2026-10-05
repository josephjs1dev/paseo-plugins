# Conductor

One Paseo inbox to monitor agents, answer questions and permissions, snooze requests,
and navigate workspaces. Open **Conductor** from the sidebar after installation.

**Needs attention** combines pending questions, approvals, failures, and manual
reminders. It is the default view; snoozed items stay hidden until they expire or
you choose **Show snoozed**. Use **Next item** to move through the attention queue.
Requests that require native controls, including Claude plan approvals and
unsupported question formats, open the agent directly when selected.

Requires Paseo **0.10.3 or a compatible 0.11 build** on the app and daemon.

Enable **Settings → Plugins → Enable plugins**, then add this **Plugin source**:

```text
https://github.com/josephjs1dev/paseo-plugins.git:conductor
```
