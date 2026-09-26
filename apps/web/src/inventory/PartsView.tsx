import CheckCircleOutlineOutlinedIcon from "@mui/icons-material/CheckCircleOutlineOutlined";
import HelpOutlineOutlinedIcon from "@mui/icons-material/HelpOutlineOutlined";
import WarningAmberOutlinedIcon from "@mui/icons-material/WarningAmberOutlined";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import LinearProgress from "@mui/material/LinearProgress";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemText from "@mui/material/ListItemText";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { formatOhms, MODULES, type InventoryItem, type Part } from "@vibread/core";
import { useRevision } from "../api/hooks.js";
import type { PartsViewProps } from "../contracts.js";

export interface PartNeed {
  key: string;
  label: string;
  module: string;
  params: Record<string, unknown>;
  need: number;
  have: number;
}

/** Fields that identify a physical module value; other params (for example tolerance) do not split the row. */
const IDENTITY_KEYS: Partial<Record<string, readonly string[]>> = {
  led: ["color"],
  resistor: ["ohms"],
  potentiometer: ["ohms"],
  generic: ["role"],
};

function identityParams(module: string, params: Record<string, unknown> | undefined): Record<string, unknown> {
  const source = params ?? {};
  const keys = IDENTITY_KEYS[module] ?? Object.keys(source).sort();
  const identity: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) identity[key] = source[key];
  }
  return identity;
}

export function partIdentityKey(module: string, params: Record<string, unknown> | undefined): string {
  return `${module}:${JSON.stringify(identityParams(module, params))}`;
}

function partValueLabel(module: string, key: string, value: unknown): string {
  if (key === "ohms" && typeof value === "number") return formatOhms(value);
  return String(value);
}

function partLabel(module: string, params: Record<string, unknown> | undefined): string {
  const name = MODULES[module as keyof typeof MODULES]?.name ?? module;
  const identity = identityParams(module, params);
  const details = Object.entries(identity).map(([key, value]) => partValueLabel(module, key, value));
  return details.length > 0 ? `${name} · ${details.join(" · ")}` : name;
}

/** Compare design needs with mission inventory by module + electrical identity values. */
export function needVsHave(designParts: Array<Pick<Part, "module" | "params">>, missionParts: InventoryItem[]): PartNeed[] {
  const haveByKey = new Map<string, number>();
  for (const item of missionParts) {
    const key = partIdentityKey(item.module, item.params);
    haveByKey.set(key, (haveByKey.get(key) ?? 0) + item.count);
  }
  const needs = new Map<string, PartNeed>();
  for (const part of designParts) {
    const key = partIdentityKey(part.module, part.params);
    const current = needs.get(key);
    if (current) {
      current.need += 1;
    } else {
      needs.set(key, {
        key,
        module: part.module,
        params: identityParams(part.module, part.params),
        label: partLabel(part.module, part.params),
        need: 1,
        have: haveByKey.get(key) ?? 0,
      });
    }
  }
  return [...needs.values()];
}


export function PartsView({ missionId, missionParts, revision }: PartsViewProps) {
  const detail = useRevision(missionId, revision);
  const rows = needVsHave(detail.data?.circuit.parts ?? [], missionParts);

  return (
    <Box sx={{ p: { xs: 2, md: 3 }, maxWidth: 720 }}>
      <Typography variant="h2" sx={{ mb: 0.5 }}>
        Parts
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        What this design needs compared with the parts attached to the mission.
      </Typography>
      {!revision ? (
        <Stack spacing={1.5} sx={{ alignItems: "flex-start" }}>
          <HelpOutlineOutlinedIcon color="disabled" />
          <Typography color="text.secondary">A design version will appear here after Claude proposes one.</Typography>
        </Stack>
      ) : detail.isLoading ? (
        <LinearProgress aria-label="Loading design parts" />
      ) : rows.length === 0 ? (
        <Typography color="text.secondary">This design has not listed any parts yet.</Typography>
      ) : (
        <List disablePadding>
          {rows.map((row, index) => {
            const enough = row.have >= row.need;
            return (
              <Box key={row.key}>
                {index > 0 ? <Divider component="li" /> : null}
                <ListItem disableGutters sx={{ py: 1.5, alignItems: "flex-start" }}>
                  {enough ? <CheckCircleOutlineOutlinedIcon color="success" sx={{ mr: 1.5, mt: 0.5 }} /> : <WarningAmberOutlinedIcon color="warning" sx={{ mr: 1.5, mt: 0.5 }} />}
                  <ListItemText primary={row.label} secondary={`Need ${row.need} · Have ${row.have}`} />
                  <Chip size="small" color={enough ? "success" : "warning"} variant={enough ? "outlined" : "filled"} label={enough ? "Ready" : `Missing ${row.need - row.have}`} />
                </ListItem>
              </Box>
            );
          })}
        </List>
      )}
    </Box>
  );
}

export default PartsView;
