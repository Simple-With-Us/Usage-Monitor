# BotFleet Receipt Authority

Exact child coverage remains default-off.  Planned enablement requires newly persisted, reconciled receipts received with the dedicated `botfleet` producer credential, plus verified sender and child correlation.  Unscoped credentials may still submit telemetry, but their rows cannot suppress child usage.

The receiver strips `_botFleetReceiptCredential` from both wire formats and sets it only after authenticating the exact BotFleet scope.  Coverage requires this server-owned stamp in addition to the existing session, call, host, model and token reconciliation.  Old unstamped receipts remain additive; enabling the flag never grants them authority retroactively.

The BotFleet credential is a trusted receipt issuer.  This authenticates the issuer; it does not independently attest provider execution or protect against a compromised BotFleet issuer lying about its own calls.  Keep the drop disabled wherever that issuer trust cannot be established.  Missing proof, lookup errors and requests outside the bounded work limit preserve child rows.
