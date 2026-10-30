# Backup Storage Inventory — 2026-10-30

## Measured B2 Inventory

A read-only inventory using the existing Usage Monitor app-scoped key completed across 15 pages and 14,102 file-version records.  The key exposed one bucket and allowed file listing, but did not allow bucket listing.  This inventory is complete for that visible bucket, not for the B2 account; bucket lifecycle rules were not available through this key.

| Prefix category | Uploaded versions | Uploaded bytes | Current-visible bytes | Hidden-by-name bytes |
| --- | ---: | ---: | ---: | ---: |
| Active replica | 2,187 | 36,033,796,714 | 12,024,121,633 | 24,009,675,081 |
| Retired replica | 4,884 | 222,520,114,709 | 57,628,172,053 | 164,891,942,656 |
| Host daily backups | 20 | 34,497,299,752 | 17,288,753,812 | 17,208,545,940 |
| **Total uploaded versions** | **7,091** | **293,051,211,175** | **86,941,047,498** | **206,110,163,677** |

The listing also contained 6,860 hide actions and 151 unfinished-upload start records.  There were 6,859 names whose newest action was hide; no older upload versions were found under names whose newest action remained visible.  Hidden uploaded bytes are included in the uploaded-version total, rather than added a second time.  Backblaze's version listing distinguishes uploaded data from hide markers, and hidden file versions continue to occupy storage until removed by lifecycle or deletion policy.  [File versions API](https://www.backblaze.com/apidocs/b2-list-file-versions)

| Replica level | Active replica bytes | Retired replica bytes |
| --- | ---: | ---: |
| L0 | 19,276,506,214 | 106,490,858,387 |
| L1 | 14,390,555,748 | 109,996,703,867 |
| L9 | 2,366,734,752 | 6,032,552,455 |

The separate unfinished-large-file listing found 151 uploads containing 11,752 stored parts totaling 117,520,000,000 bytes.  This is separate from the completed-version total; Backblaze bills uploaded large-file parts from the time they are stored.  [Large files documentation](https://www.backblaze.com/docs/cloud-storage-large-files)

| Unfinished-upload prefix | Files | Parts | Stored bytes |
| --- | ---: | ---: | ---: |
| Active replica | 7 | 597 | 5,970,000,000 |
| Retired replica | 144 | 11,155 | 111,550,000,000 |
| **Total unfinished parts** | **151** | **11,752** | **117,520,000,000** |

The directly inventoried bucket therefore held 410,571,211,175 measured bytes including unfinished parts, about 410.6 decimal GB or 382.4 GiB.  Uploaded-version bytes fell into these age bins: under 1 day, 145,868,260,015; 1–2 days, 104,593,602,439; 2–3 days, 18,578,563,029; 3–7 days, 13,891,613,200; 7–14 days, 10,119,172,492; over 14 days, zero.  Unfinished-upload ages were 89 under 1 day, 59 at 1–2 days, and 3 at 2–3 days.

## Cached App Snapshot And Scope

The latest cached Backblaze provider snapshot, read from the app database, was fetched at 1:13 AM, about half an hour before the B2 inventory.  It reported 531,568 MiB (519.11 GiB) and five associated bucket rows, four active and one partial.  The cached snapshot does not retain bucket names or per-bucket breakdown, so these totals may overlap and must not be added together.

The reported 800 GB account figure remains unreconciled.  The app-scoped listing measured one visible bucket, while the cached snapshot is a separate earlier provider view; neither proves the account's current total or explains the difference.  This evidence does not establish whether the remaining usage is in other buckets, in incomplete inventories, or in another account-level category.

## Owner-Directed Retention Targets

The owner directed these daily backup schedules, using the owner's local time:

- Socratic.Trade: 6:30 AM and 7:30 PM.
- Congress.Trade: 6:00 AM and 8:00 PM.
- Usage Monitor: 8:30 PM.

Local backup retention target: 2 days, corresponding to four Socratic.Trade copies, four Congress.Trade copies, and two Usage Monitor copies.  B2 retention target: days 1, 2, 3, 7, and 14, counting the upload day as day 1.

GB-Trader owns the backup configuration work.  The live host cron entries and America/Chicago host timezone were checked and match these schedules, local copy counts, and B2 daily/weekly/maximum-age parameters.  No backup configuration was changed during this inventory.  These checks verify configuration; future scheduled execution and remote retention outcomes require their own evidence.

