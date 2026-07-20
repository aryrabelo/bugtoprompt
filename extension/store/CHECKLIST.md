# Chrome Web Store submission checklist

Source-of-truth checklist for publishing the BugToPrompt extension on the
Chrome Web Store Developer Dashboard. Work top to bottom; each unchecked
item blocks submission unless explicitly marked optional.

## 1. Package the build

- [ ] `npm run pack:extension` from the repo root (builds + zips
      `extension/dist`). Confirm the zip only contains the built extension
      (no `.DS_Store`, no source maps unless intended).
- [ ] Load the unpacked `extension/dist/` folder in `chrome://extensions`
      with Developer mode on and manually smoke-test: popup opens, status
      pill reflects sidecar state, capture starts/stops on a `localhost`
      tab.
- [ ] Confirm `manifest.json` `version` / `version_name` match the release
      being submitted (currently `0.14.0.6` / `0.14.0-beta.6` — bump if a
      newer build is going out).

## 2. Listing content

- [ ] Copy the **Summary** and **Detailed description** fields from
      `extension/store/listing.md` into the dashboard's Store Listing tab.
- [ ] Set **Category**: Developer Tools.
- [ ] Set **Language**: English.
- [ ] Upload `extension/store/assets/small-tile-440x280.png` as the small
      promo tile.
- [ ] Upload `extension/store/assets/large-promo-920x680.png` as the large
      promo tile (optional slot, but improves featured-placement odds).
- [ ] Upload the three screenshots (`screenshot-1-popup-1280x800.png`,
      `screenshot-2-capture-1280x800.png`, `screenshot-3-issue-1280x800.png`)
      in that order, with the captions from `listing.md` in each slot's
      description field.
- [ ] Verify every uploaded image is exact-dimension PNG with no alpha
      channel (Web Store rejects images with transparency) — already
      verified for the assets in this repo via `PIL`; re-verify if any
      asset is regenerated.

## 3. Privacy — BLOCKING

- [ ] **Publish a real privacy policy page.** `listing.md` currently
      references `https://bugtoprompt.com/privacy`, which returns **404**
      as of this writing — the bugtoprompt.com landing page (separate repo)
      has no `/privacy` route yet. This must exist and be public before
      the listing can be submitted; Chrome Web Store rejects submissions
      with a dead or missing privacy policy link.
- [ ] Fill in the dashboard's **Privacy practices** tab:
      - Single purpose description (use the Summary from `listing.md`).
      - Permission justifications for `storage`, `scripting`, `activeTab`,
        the `http://localhost/*` / `127.0.0.1` host permissions, and the
        optional `http://*/*` / `https://*/*` host permissions (see
        `extension/manifest.json`).
      - Data usage disclosure: screen capture (via `getDisplayMedia`),
        microphone audio (via `getUserMedia`), interactive DOM snapshots
        (element role/name/selector/bounding-box — see
        `src/schema/index.ts` `interactiveElementSchema`), page URLs
        (`pageUrl` plus route-change events), and — for Pro users only —
        account/session data sent to `api.bugtoprompt.com`.
- [ ] Confirm the extension does not collect data beyond what's disclosed
      (Lite path stays fully local; verify no telemetry call was added
      since `SECURITY.md` was last reviewed).

## 4. Developer account & payments

- [ ] Chrome Web Store developer account is registered and the one-time
      registration fee is paid (human step — cannot be automated).
- [ ] Publisher name/logo on the dashboard matches the BugToPrompt brand
      (indigo `#4f46e5` mark, matches `extension/icons/`).

## 5. Review readiness

- [ ] Re-read `manifest.json` permissions against actual usage — Chrome
      review flags unused or overbroad permissions. In particular, justify
      `optional_host_permissions: ["http://*/*", "https://*/*"]` (used when
      a user opts a non-localhost target into capture — `listing.md`'s
      "Built for local dev" and "PRIVACY" sections already describe this
      opt-in behavior; keep them in sync if the wording changes) in the
      dashboard permission-justification field, not just in code comments.
- [ ] Confirm `host_permissions` including `https://api.bugtoprompt.com/*`
      is justified as "Pro backend communication" in the same tab.
- [ ] Double-check `SECURITY.md`'s privacy notes are consistent with what
      is submitted here — update `SECURITY.md` if the dashboard disclosure
      adds detail not yet documented in-repo.

## 6. Submit

- [ ] Submit for review.
- [ ] Note the review submission date/ID somewhere trackable (e.g. a
      comment on this issue) — Chrome review can take several business
      days and may request changes.

---

**Deferred / explicitly out of scope for this checklist:** actually
registering the Chrome Web Store developer account, paying the
registration fee, and clicking Submit are human actions and are not
performed by this change.
