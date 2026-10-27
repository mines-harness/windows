import { createFileRoute, redirect } from "@tanstack/react-router";
import { SharedGroupsPage } from "../components/contacts/SharedGroupsPage";
export const Route = createFileRoute("/shared-groups")({
  validateSearch: (search: Record<string, unknown>): { group?: string } =>
    typeof search.group === "string" && search.group.length <= 128 ? { group: search.group } : {},
  beforeLoad: ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    )
      throw redirect({ to: "/pair", replace: true });
  },
  component: SharedGroupsPage,
});
