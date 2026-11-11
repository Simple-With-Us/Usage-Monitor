import { redirect } from "next/navigation";

/** App Store Connect privacy URL alias. Canonical page is /privacy. */
export default function PrivacyPolicyAliasPage() {
  redirect("/privacy");
}
