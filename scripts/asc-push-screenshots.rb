#!/usr/bin/env ruby
# frozen_string_literal: true
# Upload screenshots from docs/asc/screenshots/{client,local}/{iphone,ipad}/*.png
# to ASC screenshot sets (APP_IPHONE_67 and APP_IPAD_PRO_3GEN_129).

require "json"
require "openssl"
require "base64"
require "net/http"
require "uri"
require "optparse"
require "digest"

# AFC-359: credentials come from the environment, else Infisical Fleet-OPS via
# `fleet-secrets get` (folder /asc:  ASC_KEY_ID, ASC_ISSUER_ID,
# ASC_KEY_P8 = the .p8 text).  Nothing is read from a file under ~/.secrets;  never printed.
require "open3"
FLEET_SECRETS_BIN = ENV.fetch("FLEET_SECRETS_BIN", File.expand_path("~/.local/bin/fleet-secrets"))
def asc_value(name, folder)
  v = ENV[name].to_s.strip
  return v unless v.empty?
  out, _err, st = Open3.capture3(FLEET_SECRETS_BIN, "get", name, "--path", folder)
  st.success? ? out.strip : ""
rescue Errno::ENOENT
  ""
end
ENV["ASC_KEY_ID"] = asc_value("ASC_KEY_ID", "/asc")
ENV["ASC_ISSUER_ID"] = asc_value("ASC_ISSUER_ID", "/asc")
abort "missing ASC_KEY_ID / ASC_ISSUER_ID (env, or Infisical /asc)" if ENV["ASC_KEY_ID"].empty? || ENV["ASC_ISSUER_ID"].empty?

def asc_private_key_pem
  path = ENV["ASC_KEY_PATH"].to_s
  return File.read(File.expand_path(path)) if !path.empty? && File.file?(File.expand_path(path))
  pem = ENV["ASC_KEY_P8"].to_s.strip
  pem = asc_value("ASC_KEY_P8", "/asc") if pem.empty?
  abort "missing ASC private key (ASC_KEY_PATH, ASC_KEY_P8, or Infisical /asc ASC_KEY_P8)" if pem.empty?
  pem
end

ROOT = File.expand_path("..", __dir__)
SHOT_ROOT = File.join(ROOT, "docs/asc/screenshots")

APPS = {
  "client" => { loc_id: "806f8051-efc5-4edf-8527-3ccbdcdb79a3" },
  "local" => { loc_id: "09c8eb6b-8f6d-4629-b14b-6e30a5d73da6" },
}.freeze

DISPLAY = {
  "iphone" => "APP_IPHONE_67",
  "ipad" => "APP_IPAD_PRO_3GEN_129",
}.freeze

def b64(h)
  Base64.urlsafe_encode64(h.is_a?(String) ? h : JSON.generate(h), padding: false)
end

def jwt_token
  key = OpenSSL::PKey::EC.new(asc_private_key_pem)
  now = Time.now.to_i
  seg = "#{b64({ alg: "ES256", kid: ENV.fetch("ASC_KEY_ID"), typ: "JWT" })}.#{b64({ iss: ENV.fetch("ASC_ISSUER_ID"), iat: now, exp: now + 1200, aud: "appstoreconnect-v1" })}"
  der = key.dsa_sign_asn1(OpenSSL::Digest::SHA256.digest(seg))
  asn1 = OpenSSL::ASN1.decode(der)
  r = asn1.value[0].value.to_s(2).rjust(32, "\x00")[-32..]
  s = asn1.value[1].value.to_s(2).rjust(32, "\x00")[-32..]
  "#{seg}.#{Base64.urlsafe_encode64(r + s, padding: false)}"
end

def request(method, path, body: nil, token: jwt_token, headers: {})
  uri = URI("https://api.appstoreconnect.apple.com#{path}")
  req = { get: Net::HTTP::Get, post: Net::HTTP::Post, patch: Net::HTTP::Patch, delete: Net::HTTP::Delete }.fetch(method).new(uri)
  req["Authorization"] = "Bearer #{token}"
  headers.each { |k, v| req[k] = v }
  if body
    req["Content-Type"] ||= "application/json"
    req.body = body.is_a?(String) ? body : JSON.generate(body)
  end
  res = Net::HTTP.start(uri.hostname, uri.port, use_ssl: true) { |h| h.request(req) }
  parsed = begin
    res.body.empty? ? {} : JSON.parse(res.body)
  rescue JSON::ParserError
    { "raw" => res.body[0, 500] }
  end
  [res.code.to_i, parsed, res]
end

def ensure_set(loc_id, display_type)
  code, data = request(:get, "/v1/appStoreVersionLocalizations/#{loc_id}/appScreenshotSets")
  (data["data"] || []).each do |s|
    return s["id"] if s.dig("attributes", "screenshotDisplayType") == display_type
  end
  body = {
    data: {
      type: "appScreenshotSets",
      attributes: { screenshotDisplayType: display_type },
      relationships: {
        appStoreVersionLocalization: {
          data: { type: "appStoreVersionLocalizations", id: loc_id },
        },
      },
    },
  }
  code, data = request(:post, "/v1/appScreenshotSets", body: body)
  abort "create set failed HTTP #{code}: #{data}" if code >= 400
  data.dig("data", "id")
end

def clear_set(set_id)
  code, data = request(:get, "/v1/appScreenshotSets/#{set_id}/appScreenshots")
  (data["data"] || []).each do |shot|
    sid = shot["id"]
    c, = request(:delete, "/v1/appScreenshots/#{sid}")
    puts "  deleted screenshot #{sid} HTTP #{c}"
  end
end

def upload_png(set_id, path, position)
  bytes = File.binread(path)
  size = bytes.bytesize
  name = File.basename(path)
  body = {
    data: {
      type: "appScreenshots",
      attributes: { fileName: name, fileSize: size },
      relationships: {
        appScreenshotSet: { data: { type: "appScreenshotSets", id: set_id } },
      },
    },
  }
  code, data = request(:post, "/v1/appScreenshots", body: body)
  abort "reserve failed HTTP #{code}: #{data}" if code >= 400
  shot_id = data.dig("data", "id")
  ops = data.dig("data", "attributes", "uploadOperations") || []
  ops.each do |op|
    url = URI(op["url"])
    req = Net::HTTP::Put.new(url)
    (op["requestHeaders"] || []).each { |h| req[h["name"]] = h["value"] }
    offset = op["offset"] || 0
    length = op["length"] || size
    req.body = bytes.byteslice(offset, length)
    res = Net::HTTP.start(url.hostname, url.port, use_ssl: url.scheme == "https") { |h| h.request(req) }
    abort "upload part failed HTTP #{res.code}" if res.code.to_i >= 300
  end
  checksum = Digest::MD5.base64digest(bytes)
  commit = {
    data: {
      type: "appScreenshots",
      id: shot_id,
      attributes: {
        uploaded: true,
        sourceFileChecksum: checksum,
      },
    },
  }
  code, data = request(:patch, "/v1/appScreenshots/#{shot_id}", body: commit)
  puts "  uploaded #{name} pos≈#{position} → HTTP #{code} id=#{shot_id}"
  puts JSON.pretty_generate(data["errors"]) if code >= 400
  shot_id
end

options = { apps: [], replace: true }
OptionParser.new do |o|
  o.on("--all") { options[:apps] = APPS.keys }
  o.on("--app NAME") { |n| options[:apps] << n }
  o.on("--keep") { options[:replace] = false }
end.parse!
options[:apps] = APPS.keys if options[:apps].empty?

options[:apps].each do |app_key|
  loc_id = APPS.fetch(app_key)[:loc_id]
  puts "=== #{app_key} ==="
  DISPLAY.each do |folder, display_type|
    dir = File.join(SHOT_ROOT, app_key, folder)
    next unless Dir.exist?(dir)
    files = Dir[File.join(dir, "*.png")].sort
    next if files.empty?
    puts "set #{display_type} (#{files.size} files)"
    set_id = ensure_set(loc_id, display_type)
    clear_set(set_id) if options[:replace]
    files.each_with_index { |f, i| upload_png(set_id, f, i + 1) }
  end
end
puts "done"
