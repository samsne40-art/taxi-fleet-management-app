---
name: Notifications
description: Durable notification and alert architecture for owner and driver users.
---

Persistent notifications are created through one shared helper that inserts the row first and emits the exact stored row to the recipient's authenticated Socket.io room.

**Why:** Alerts must survive refreshes while still appearing immediately, and using the stored timestamp keeps real-time and fetched notifications consistent.

**How to apply:** Keep recipient scope server-side (`owner_<id>` or `driver_<id>`), derive API reads and writes from the session user ID, and preserve the existing guarded room-join rules when adding new alert types.