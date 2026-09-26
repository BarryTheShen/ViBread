import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import ErrorIcon from "@mui/icons-material/Error";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemText from "@mui/material/ListItemText";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useColorScheme } from "@mui/material/styles";
import type { CompileDiagnostic, RevisionDetail } from "@vibread/core";
import { useState } from "react";
import SyntaxHighlighter from "react-syntax-highlighter/dist/esm/prism-light";
import cpp from "react-syntax-highlighter/dist/esm/languages/prism/cpp";
import { oneLight, vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import { MONO_FONT } from "../../theme.js";

SyntaxHighlighter.registerLanguage("cpp", cpp);

function isSketchFile(file: string | undefined): boolean {
  if (!file) return false;
  const path = file.replaceAll("\\", "/").toLowerCase();
  if (/(^|\/)(cores|libraries|framework|toolchain)\//.test(path)) return false;
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.endsWith(".ino") || base === "sketch.cpp";
}

function DiagnosticList({ items }: { items: CompileDiagnostic[] }) {
  return (
    <List dense disablePadding>
      {items.map((d, i) => (
        <ListItem key={i} disableGutters>
          <ListItemText
            primary={d.message.split(/\\n|\n/)[0]}
            secondary={`${d.file ? `${d.file.split("/").pop()} ` : ""}${d.line ? `line ${d.line}${d.column ? `:${d.column}` : ""} · ` : ""}${d.severity}`}
            slotProps={{ primary: { sx: { fontFamily: MONO_FONT, fontSize: 12.5 } } }}
          />
        </ListItem>
      ))}
    </List>
  );
}

export function CodeTab({ revision }: { revision: RevisionDetail }) {
  const source = revision.circuit.sketch.source;
  const compile = revision.results.compile;
  // The palette is CSS variables, so the resolved light/dark scheme comes from useColorScheme, not the theme object.
  const { mode, systemMode } = useColorScheme();
  const dark = (mode === "system" ? systemMode : mode) === "dark";
  const [copied, setCopied] = useState(false);
  const [showCore, setShowCore] = useState(false);
  const errors = compile?.diagnostics.filter((d) => d.severity === "error") ?? [];
  const warnings = compile?.diagnostics.filter((d) => d.severity === "warning") ?? [];
  // Same split as the firmware console (GUIDO): only .ino / sketch.cpp diagnostics are about the user's code.
  const sketchWarnings = warnings.filter((d) => isSketchFile(d.file));
  const coreWarnings = warnings.filter((d) => !isSketchFile(d.file));
  const shown = [...errors, ...sketchWarnings];

  return (
    <Stack sx={{ gap: 1.5 }}>
      <Stack direction="row" sx={{ gap: 1, alignItems: "center", flexWrap: "wrap" }}>
        <Typography variant="h6" component="h2" sx={{ flex: 1 }}>
          Arduino sketch
        </Typography>
        {compile ? (
          <Chip
            icon={compile.ok ? <CheckCircleIcon /> : <ErrorIcon />}
            color={compile.ok ? "success" : "error"}
            label={compile.ok ? "Compiles" : "Doesn't compile"}
          />
        ) : (
          <Chip variant="outlined" label="Not compiled yet" />
        )}
        {compile?.sizes && (
          <Chip
            variant="outlined"
            label={`Uses ${Math.round((compile.sizes.flashBytes / compile.sizes.flashMax) * 100)}% of memory · ${compile.sizes.flashBytes.toLocaleString()} bytes`}
          />
        )}
        <Button
          startIcon={<ContentCopyIcon />}
          onClick={() =>
            void navigator.clipboard.writeText(source).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            })
          }
        >
          {copied ? "Copied" : "Copy code"}
        </Button>
      </Stack>
      {coreWarnings.length > 0 && (
        <Box>
          <Button size="small" onClick={() => setShowCore((v) => !v)} aria-expanded={showCore}>
            {showCore ? "Hide" : "Show"} {coreWarnings.length} warning{coreWarnings.length === 1 ? "" : "s"} from the Arduino core (not your code)
          </Button>
          {showCore && (
            <Alert severity="info" sx={{ maxHeight: 220, overflow: "auto", mt: 0.5 }}>
              <DiagnosticList items={coreWarnings} />
            </Alert>
          )}
        </Box>
      )}
      {shown.length > 0 && (
        <Alert severity={errors.length > 0 ? "error" : "warning"} sx={{ maxHeight: 260, overflow: "auto" }}>
          <DiagnosticList items={shown} />
        </Alert>
      )}
      <Box sx={{ borderRadius: 1, overflow: "hidden", border: 1, borderColor: "divider" }}>
        <SyntaxHighlighter
          language="cpp"
          style={dark ? vscDarkPlus : oneLight}
          showLineNumbers
          customStyle={{ margin: 0, fontSize: 13, fontFamily: MONO_FONT, background: "var(--mui-palette-code-main)", maxHeight: "65vh" }}
          codeTagProps={{ style: { fontFamily: MONO_FONT } }}
        >
          {source}
        </SyntaxHighlighter>
      </Box>
    </Stack>
  );
}
