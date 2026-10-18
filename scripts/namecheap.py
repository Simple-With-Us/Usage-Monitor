#!/usr/bin/env python3
"""
Namecheap API client & CLI for AI Agents and fleet operations.
Allows querying account balances, listing domains, checking availability, and viewing DNS records.

The account username (sent as both ApiUser and UserName) is resolved from
$NAMECHEAP_API_USER or `fleet-secrets get NAMECHEAP_API_USER`, exactly like the API key — it is
never hardcoded here (this repo is public; account details live in the private
fleet-ops ATTACK-MAP.md).  A wrong username makes the API return error 1011102
"API Key is invalid", even when the key itself is fine.

Usage:
  python3 scripts/namecheap.py balances
  python3 scripts/namecheap.py domains
  python3 scripts/namecheap.py check example.com
  python3 scripts/namecheap.py dns example com
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET


def _read_secret(name):
    val = os.environ.get(name)
    if val:
        return val.strip().strip("\"'")

    # OPS-818: the flat ~/.secrets file is no longer read.  Fall back to the
    # Mac-side fleet-secrets CLI;  stdout is captured and never logged.
    binary = shutil.which("fleet-secrets") or os.path.expanduser("~/.local/bin/fleet-secrets")
    for secret_path in ("/", "/global-api-keys"):
        try:
            result = subprocess.run(
                [binary, "get", name, "--path", secret_path],
                capture_output=True,
                text=True,
                timeout=30,
            )
        except (OSError, subprocess.SubprocessError):
            return None
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip().strip("\"'")
    return None


def get_api_key():
    return _read_secret("NAMECHEAP_API_KEY")


def get_api_user():
    return _read_secret("NAMECHEAP_API_USER")


def get_public_ip():
    env_ip = os.environ.get("NAMECHEAP_CLIENT_IP")
    if env_ip:
        return env_ip.strip()
    try:
        req = urllib.request.Request(
            "https://api.ipify.org", headers={"User-Agent": "UsageMonitorAgent/1.0"}
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.read().decode("utf-8").strip()
    except Exception:
        return "127.0.0.1"


def call_namecheap(command, params=None, api_user=None, api_key=None, client_ip=None):
    if not api_key:
        api_key = get_api_key()
    if not api_key:
        raise ValueError("NAMECHEAP_API_KEY not found in environment or `fleet-secrets get`")

    if not api_user:
        api_user = get_api_user()
    if not api_user:
        raise ValueError("NAMECHEAP_API_USER not found in environment or `fleet-secrets get`")

    if not client_ip:
        client_ip = get_public_ip()

    query_params = {
        "ApiUser": api_user,
        "ApiKey": api_key,
        "UserName": api_user,
        "ClientIP": client_ip,
        "Command": command,
    }
    if params:
        query_params.update(params)

    url = "https://api.namecheap.com/xml.response?" + urllib.parse.urlencode(query_params)
    req = urllib.request.Request(url, headers={"User-Agent": "UsageMonitorAgent/1.0"})

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            content = resp.read().decode("utf-8")
            root = ET.fromstring(content)
            status = root.attrib.get("Status", "UNKNOWN")

            if status != "OK":
                errors = [e.text for e in root.findall(".//{http://api.namecheap.com/xml.response}Error") if e.text]
                err_msg = "; ".join(errors) if errors else "Unknown API error"
                return {"ok": False, "status": status, "error": err_msg, "raw": content}

            return {"ok": True, "status": status, "root": root, "raw": content}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def cmd_balances(args):
    res = call_namecheap("namecheap.users.getBalances", api_user=args.user, client_ip=args.ip)
    if not res["ok"]:
        print(f"Error fetching balances: {res.get('error')}", file=sys.stderr)
        return 1

    root = res["root"]
    ns = "{http://api.namecheap.com/xml.response}"
    elem = root.find(f".//{ns}UserGetBalancesResult")
    if elem is not None:
        data = {
            "Currency": elem.attrib.get("Currency", "USD"),
            "AvailableBalance": elem.attrib.get("AvailableBalance"),
            "AccountBalance": elem.attrib.get("AccountBalance"),
            "EarnedAmount": elem.attrib.get("EarnedAmount"),
            "WithdrawableAmount": elem.attrib.get("WithdrawableAmount"),
            "FundsRequiredForAutoRenew": elem.attrib.get("FundsRequiredForAutoRenew"),
        }
        if args.json:
            print(json.dumps(data, indent=2))
        else:
            print("Namecheap Account Balances:")
            print(f"  Available Balance: ${data['AvailableBalance']} {data['Currency']}")
            print(f"  Account Balance:   ${data['AccountBalance']} {data['Currency']}")
            print(f"  Funds for Auto-Renew: ${data['FundsRequiredForAutoRenew']}")
        return 0
    else:
        print("No UserGetBalancesResult element found in response", file=sys.stderr)
        return 1


def cmd_domains(args):
    res = call_namecheap("namecheap.domains.getList", {"PageSize": "100"}, api_user=args.user, client_ip=args.ip)
    if not res["ok"]:
        print(f"Error fetching domains: {res.get('error')}", file=sys.stderr)
        return 1

    root = res["root"]
    ns = "{http://api.namecheap.com/xml.response}"
    domain_elems = root.findall(f".//{ns}Domain")
    domains = []
    for d in domain_elems:
        domains.append({
            "id": d.attrib.get("ID"),
            "name": d.attrib.get("Name"),
            "user": d.attrib.get("User"),
            "created": d.attrib.get("Created"),
            "expires": d.attrib.get("Expires"),
            "isExpired": d.attrib.get("IsExpired") == "true",
            "autoRenew": d.attrib.get("AutoRenew") == "true",
        })

    if args.json:
        print(json.dumps(domains, indent=2))
    else:
        print(f"Active Namecheap Domains ({len(domains)} total):")
        for d in domains:
            renew_str = "Auto-renew ON" if d["autoRenew"] else "Auto-renew OFF"
            print(f"  - {d['name']:<30} Expires: {d['expires']:<12} ({renew_str})")
    return 0


def cmd_check(args):
    domain = args.domain.strip()
    res = call_namecheap("namecheap.domains.check", {"DomainList": domain}, api_user=args.user, client_ip=args.ip)
    if not res["ok"]:
        print(f"Error checking domain {domain}: {res.get('error')}", file=sys.stderr)
        return 1

    root = res["root"]
    ns = "{http://api.namecheap.com/xml.response}"
    elem = root.find(f".//{ns}DomainCheckResult")
    if elem is not None:
        avail = elem.attrib.get("Available", "").lower() == "true"
        data = {
            "domain": elem.attrib.get("Domain", domain),
            "available": avail,
            "isPremiumName": elem.attrib.get("IsPremiumName") == "true",
        }
        if args.json:
            print(json.dumps(data, indent=2))
        else:
            status_str = "AVAILABLE" if avail else "TAKEN / UNAVAILABLE"
            print(f"Domain {data['domain']}: {status_str}")
        return 0
    return 1


def cmd_dns(args):
    sld = args.sld.strip()
    tld = args.tld.strip()
    res = call_namecheap("namecheap.domains.dns.getHosts", {"SLD": sld, "TLD": tld}, api_user=args.user, client_ip=args.ip)
    if not res["ok"]:
        print(f"Error fetching DNS for {sld}.{tld}: {res.get('error')}", file=sys.stderr)
        return 1

    root = res["root"]
    ns = "{http://api.namecheap.com/xml.response}"
    host_elems = root.findall(f".//{ns}host")
    hosts = []
    for h in host_elems:
        hosts.append({
            "name": h.attrib.get("Name"),
            "type": h.attrib.get("Type"),
            "address": h.attrib.get("Address"),
            "ttl": h.attrib.get("TTL"),
            "mxPref": h.attrib.get("MXPref"),
        })

    if args.json:
        print(json.dumps(hosts, indent=2))
    else:
        print(f"DNS Host Records for {sld}.{tld} ({len(hosts)} records):")
        for h in hosts:
            print(f"  {h['name']:<15} {h['type']:<8} {h['address']:<30} (TTL={h['ttl']})")
    return 0


def main():
    parser = argparse.ArgumentParser(description="Namecheap API CLI for Agents & Fleet Operations")
    parser.add_argument("--user", default=None, help="Namecheap username (default: $NAMECHEAP_API_USER or `fleet-secrets get NAMECHEAP_API_USER`)")
    parser.add_argument("--ip", default=None, help="Whitelisted client IP (default: auto-detected public IP)")
    parser.add_argument("--json", action="store_true", help="Output raw JSON")

    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("balances", help="Get account prepaid balances")
    subparsers.add_parser("domains", help="List active domains and expiration dates")

    p_check = subparsers.add_parser("check", help="Check if a domain is available")
    p_check.add_argument("domain", help="Domain to check (e.g. example.com)")

    p_dns = subparsers.add_parser("dns", help="Get DNS host records for a domain")
    p_dns.add_argument("sld", help="Second-level domain (e.g. example)")
    p_dns.add_argument("tld", help="Top-level domain (e.g. com)")

    args = parser.parse_args()

    if args.command == "balances":
        sys.exit(cmd_balances(args))
    elif args.command == "domains":
        sys.exit(cmd_domains(args))
    elif args.command == "check":
        sys.exit(cmd_check(args))
    elif args.command == "dns":
        sys.exit(cmd_dns(args))


if __name__ == "__main__":
    main()
