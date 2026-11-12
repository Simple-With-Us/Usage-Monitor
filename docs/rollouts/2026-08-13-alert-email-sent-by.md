# 2026-08-13 — Alert emails sign off as Usage Monitor

Owner received Socratic.Trade Litestream mail from `alerts@updates.jays.services` and asked whether Usage Monitor sent it.

It did not.  ST `notify()` sent that mail.  Usage Monitor Resend HTML already said "Usage Monitor Alert" at the top but had no end-of-body sign-off.

Every Resend alert body now ends with `(sent by Usage Monitor)` so a shared From address cannot hide the sender.
