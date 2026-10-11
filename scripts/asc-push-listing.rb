#!/usr/bin/env ruby
# frozen_string_literal: true
# Push App Store Connect listing metadata for Usage Client + Local Monitor.
# Credentials: ~/.secrets/appstore-connect.env (never printed).
#
# Usage:
#   ruby scripts/asc-push-listing.rb --all
#   ruby scripts/asc-push-listing.rb --app client
#   ruby scripts/asc-push-listing.rb --app local

require "json"
require "openssl"
require "base64"
require "net/http"
require "uri"
require "optparse"

ENV_PATH = File.expand_path("~/.secrets/appstore-connect.env")
abort "missing #{ENV_PATH}" unless File.file?(ENV_PATH)
File.readlines(ENV_PATH).each do |line|
  line = line.strip
  next if line.empty? || line.start_with?("#")
  k, v = line.split("=", 2)
  ENV[k] = v&.strip&.delete_prefix('"')&.delete_suffix('"') if k && v
end

APPS = {
  "client" => {
    # Owner ruling 2026-10-11: the live record is 6820881005, created for
    # com.simplewithus.usage.client.ios. The old IDs (app 6799230435 and its
    # version/localization IDs) belong to the retired
    # services.jays.usage.client.monitor record.
    app_id: 6820881005,
    version_id: nil,
    loc_id: nil,
    app_info_id: nil,
    app_info_loc_id: nil,
    name: "Usage Client Monitor",
    subtitle: "Live budgets for API spend",
    promotional_text: "Connect your self-hosted Usage Monitor server. See month-to-date spend, provider budgets, project allocation, and alerts — with Face ID lock and offline widgets.",
    description: <<~TXT.strip,
      Usage Client Monitor is the iOS companion for a Usage Monitor server you host.

      See month-to-date API spend, budgets, and alerts without living in a browser tab. Point the app at your server URL, store a read token in the Keychain, and keep budgets on your Lock Screen and Home Screen widgets.

      WHAT IT DOES
      • Live Overview — spent this month, budget pace, and projected end-of-month
      • Providers — per-provider spend, budgets, and detail history
      • Project budgets — allocate cost across the work that matters
      • Alerts — budget warnings and exceedances, with optional local notifications
      • Face ID / passcode lock so money figures stay private on a shared device
      • Offline cache + widgets after the first successful sync

      WHO IT IS FOR
      Operators who already run (or will run) Usage Monitor on their own infrastructure — including the open/self-host path documented with the project. This app is a client. It does not replace hosting the server.

      WHAT YOU NEED
      • A reachable Usage Monitor base URL (HTTPS)
      • A read or full-access token issued by that server

      Privacy-minded: the developer does not receive your traffic unless you choose a server they operate. Your token stays in the device Keychain.

      Not a brokerage, bank, or tax product — developer tooling for API cost visibility.
    TXT
    keywords: "api,budget,cost,usage,openai,anthropic,llm,devops,monitor,self-host,spend",
    whats_new: "Initial App Store release of Usage Client Monitor — live budgets, providers, project allocation, alerts, Face ID lock, and widgets for your self-hosted Usage Monitor server.",
    review_notes: <<~TXT.strip,
      This is a client for a self-hosted Usage Monitor server (developer tools).

      No public demo account is required for binary smoke checks: launch shows Settings connection fields when no token is stored.

      To exercise live data (optional):
      1. Set Base URL to the reviewer’s own Usage Monitor instance, OR
      2. Contact mail@jays.services for a short-lived read-only review host if needed.

      Face ID is optional (Settings → App Lock). Disable App Lock for review if preferred.

      Encryption: standard HTTPS + Keychain only; ITSAppUsesNonExemptEncryption is false.
    TXT
  },
  "local" => {
    # Owner ruling 2026-10-11: the live record is 6820885210, created for
    # com.simplewithus.usage.local.ios. The old IDs (app 6799230729 and its
    # version/localization IDs) belong to the retired
    # services.jays.usage.local.monitor record.
    app_id: 6820885210,
    version_id: nil,
    loc_id: nil,
    app_info_id: nil,
    app_info_loc_id: nil,
    name: "Usage Local Monitor",
    subtitle: "On-device API budget tracker",
    promotional_text: "Track OpenRouter, OpenAI, Anthropic, and more on your phone — keys in Keychain, budgets in on-device SQLite. No Usage Monitor server required.",
    description: <<~TXT.strip,
      Usage Local Monitor keeps API and subscription spend visible on your iPhone — entirely on-device.

      Add the providers you already pay for, store keys in the Keychain, and see month-to-date cost, budgets, renewals, and alerts without running a separate server.

      WHAT IT DOES
      • On-device Overview — spent this month, budget remaining, projected end-of-month
      • Provider catalog aligned with real developer stacks (LLM, hosting, data, infra)
      • Poll adapters where providers expose cost or balance APIs (for example OpenRouter, OpenAI org costs, Anthropic Admin cost report, DeepSeek balance)
      • Recurring fees as subscriptions that materialize into the same spend totals
      • Projects — optional budgets for each effort
      • Export / import packages (keys never included in exports)
      • Face ID / passcode lock
      • Wipe local data when you want a clean slate

      WHO IT IS FOR
      Individual developers and small teams who want phone-first cost awareness without hosting Usage Monitor.

      WHAT IT IS NOT
      • Not a remote dashboard client (that is Usage Client Monitor)
      • Not a bank, brokerage, or tax product
      • Does not invent spend for providers that only offer console billing — those stay as subscription or manual rows

      Privacy-minded: processing is on-device. Keys leave the device only over HTTPS to providers you choose.
    TXT
    keywords: "api,budget,cost,openai,anthropic,openrouter,llm,local,on-device,usage,spend",
    whats_new: "Initial App Store release of Usage Local Monitor — on-device budgets, provider catalog, poll adapters, subscriptions, projects, export/import, and Face ID lock. No server required.",
    review_notes: <<~TXT.strip,
      On-device developer tools app. No login and no developer-operated backend.

      First launch seeds an empty/local catalog. To see non-zero month-to-date cost:
      1. Add Provider → choose OpenRouter (or similar)
      2. Paste a management/provisioning key if the provider requires it for cost APIs
      3. Pull to refresh

      Inference-only keys may show connected without MTD cost — expected.

      Face ID is optional. Encryption is standard HTTPS + Keychain only.
    TXT
  },
}.freeze

PRIVACY_URL = "https://usage.jays.services/privacy"
SUPPORT_URL = "https://usage.jays.services/support"
MARKETING_URL = "https://usage.jays.services"

def b64(h)
  Base64.urlsafe_encode64(h.is_a?(String) ? h : JSON.generate(h), padding: false)
end

def jwt_token
  key = OpenSSL::PKey::EC.new(File.read(File.expand_path(ENV.fetch("ASC_KEY_PATH"))))
  now = Time.now.to_i
  seg = "#{b64({ alg: "ES256", kid: ENV.fetch("ASC_KEY_ID"), typ: "JWT" })}.#{b64({ iss: ENV.fetch("ASC_ISSUER_ID"), iat: now, exp: now + 1200, aud: "appstoreconnect-v1" })}"
  der = key.dsa_sign_asn1(OpenSSL::Digest::SHA256.digest(seg))
  asn1 = OpenSSL::ASN1.decode(der)
  r = asn1.value[0].value.to_s(2).rjust(32, "\x00")[-32..]
  s = asn1.value[1].value.to_s(2).rjust(32, "\x00")[-32..]
  "#{seg}.#{Base64.urlsafe_encode64(r + s, padding: false)}"
end

def request(method, path, body: nil, token: jwt_token)
  uri = URI("https://api.appstoreconnect.apple.com#{path}")
  req = case method
        when :get then Net::HTTP::Get.new(uri)
        when :patch then Net::HTTP::Patch.new(uri)
        when :post then Net::HTTP::Post.new(uri)
        else raise "bad method"
        end
  req["Authorization"] = "Bearer #{token}"
  req["Content-Type"] = "application/json" if body
  req.body = JSON.generate(body) if body
  res = Net::HTTP.start(uri.hostname, uri.port, use_ssl: true) { |h| h.request(req) }
  raw = res.body.to_s
  parsed = raw.empty? ? {} : (JSON.parse(raw) rescue { "raw" => raw[0, 500] })
  [res.code.to_i, parsed]
end

def patch_localization(cfg)
  attrs = {
    description: cfg[:description],
    keywords: cfg[:keywords],
    marketingUrl: MARKETING_URL,
    promotionalText: cfg[:promotional_text],
    supportUrl: SUPPORT_URL,
  }
  # First version often cannot set whatsNew — try without, then with if needed.
  body = {
    data: {
      type: "appStoreVersionLocalizations",
      id: cfg[:loc_id],
      attributes: attrs,
    },
  }
  code, data = request(:patch, "/v1/appStoreVersionLocalizations/#{cfg[:loc_id]}", body: body)
  puts "version localization #{cfg[:name]} → HTTP #{code}"
  puts JSON.pretty_generate(data["errors"] || { ok: true }) if code >= 400 || ENV["VERBOSE"]
end

def patch_app_info_localization(cfg)
  body = {
    data: {
      type: "appInfoLocalizations",
      id: cfg[:app_info_loc_id],
      attributes: {
        name: cfg[:name],
        subtitle: cfg[:subtitle],
        privacyPolicyUrl: PRIVACY_URL,
      },
    },
  }
  code, data = request(:patch, "/v1/appInfoLocalizations/#{cfg[:app_info_loc_id]}", body: body)
  puts "app info localization #{cfg[:name]} → HTTP #{code}"
  puts JSON.pretty_generate(data["errors"] || { ok: true }) if code >= 400 || ENV["VERBOSE"]
end

def patch_categories(cfg)
  # primaryCategory relationship on appInfos
  body = {
    data: {
      type: "appInfos",
      id: cfg[:app_info_id],
      relationships: {
        primaryCategory: {
          data: { type: "appCategories", id: "DEVELOPER_TOOLS" },
        },
        secondaryCategory: {
          data: { type: "appCategories", id: "PRODUCTIVITY" },
        },
      },
    },
  }
  code, data = request(:patch, "/v1/appInfos/#{cfg[:app_info_id]}", body: body)
  puts "categories #{cfg[:name]} → HTTP #{code}"
  puts JSON.pretty_generate(data["errors"] || { ok: true }) if code >= 400 || ENV["VERBOSE"]
end

def patch_age_rating(cfg)
  code, data = request(:get, "/v1/appInfos/#{cfg[:app_info_id]}/ageRatingDeclaration")
  unless data["data"]
    puts "age rating missing for #{cfg[:name]}: #{data.inspect[0, 300]}"
    return
  end
  id = data["data"]["id"]
  # Mix of enum (NONE) and boolean fields — ASC is picky about types.
  attrs = {
    "alcoholTobaccoOrDrugUseOrReferences" => "NONE",
    "contests" => "NONE",
    "gamblingSimulated" => "NONE",
    "gunsOrOtherWeapons" => "NONE",
    "medicalOrTreatmentInformation" => "NONE",
    "profanityOrCrudeHumor" => "NONE",
    "sexualContentGraphicAndNudity" => "NONE",
    "sexualContentOrNudity" => "NONE",
    "horrorOrFearThemes" => "NONE",
    "matureOrSuggestiveThemes" => "NONE",
    "violenceCartoonOrFantasy" => "NONE",
    "violenceRealisticProlongedGraphicOrSadistic" => "NONE",
    "violenceRealistic" => "NONE",
    # Booleans (ASC expects true/false, not NONE)
    "advertising" => false,
    "gambling" => false,
    "healthOrWellnessTopics" => false,
    "messagingAndChat" => false,
    "parentalControls" => false,
    "lootBox" => false,
    "unrestrictedWebAccess" => false,
    "userGeneratedContent" => false,
    "ageAssurance" => false,
  }
  body = {
    data: {
      type: "ageRatingDeclarations",
      id: id,
      attributes: attrs,
    },
  }
  code, data = request(:patch, "/v1/ageRatingDeclarations/#{id}", body: body)
  puts "age rating #{cfg[:name]} → HTTP #{code}"
  if code >= 400
    puts JSON.pretty_generate(data["errors"] || data)[0, 1500]
  end
end

def upsert_review_detail(cfg)
  code, data = request(:get, "/v1/appStoreVersions/#{cfg[:version_id]}/appStoreReviewDetail")
  attrs = {
    contactFirstName: "Jay",
    contactLastName: "Wedgeworth",
    contactPhone: "+19564200244",
    contactEmail: "mail@jays.services",
    demoAccountRequired: false,
    notes: cfg[:review_notes],
  }
  if data["data"]
    id = data["data"]["id"]
    body = { data: { type: "appStoreReviewDetails", id: id, attributes: attrs } }
    code, data = request(:patch, "/v1/appStoreReviewDetails/#{id}", body: body)
  else
    body = {
      data: {
        type: "appStoreReviewDetails",
        attributes: attrs,
        relationships: {
          appStoreVersion: { data: { type: "appStoreVersions", id: cfg[:version_id] } },
        },
      },
    }
    code, data = request(:post, "/v1/appStoreReviewDetails", body: body)
  end
  puts "review detail #{cfg[:name]} → HTTP #{code}"
  puts JSON.pretty_generate(data["errors"] || { ok: true }) if code >= 400 || ENV["VERBOSE"]
end

def attach_latest_build(cfg)
  code, data = request(:get, "/v1/builds?filter[app]=#{cfg[:app_id]}&filter[processingState]=VALID&sort=-uploadedDate&limit=1")
  build = data.dig("data", 0)
  unless build
    puts "no VALID build for #{cfg[:name]} (HTTP #{code})"
    return
  end
  body = { data: { type: "builds", id: build["id"] } }
  code, data = request(:patch, "/v1/appStoreVersions/#{cfg[:version_id]}/relationships/build", body: body)
  puts "attach build #{build.dig("attributes", "version")} → version #{cfg[:name]} HTTP #{code}"
  puts JSON.pretty_generate(data["errors"] || { build: build["id"] }) if code >= 400 || ENV["VERBOSE"]
end

options = { apps: [] }
OptionParser.new do |o|
  o.on("--all") { options[:apps] = APPS.keys }
  o.on("--app NAME", String) { |n| options[:apps] << n }
end.parse!
options[:apps] = APPS.keys if options[:apps].empty?

options[:apps].each do |key|
  cfg = APPS[key] or abort "unknown app #{key}"
  missing = %i[app_id version_id loc_id app_info_id app_info_loc_id].select { |k| cfg[k].nil? }
  unless missing.empty?
    abort "refusing to push #{key}: still missing #{missing.join(', ')} in APPS -- " \
          "the script does not discover these; fill them in from the App Store Connect record"
  end
  puts "=== #{key} ==="
  patch_localization(cfg)
  patch_app_info_localization(cfg)
  patch_categories(cfg)
  patch_age_rating(cfg)
  upsert_review_detail(cfg)
  attach_latest_build(cfg)
end
puts "done"
