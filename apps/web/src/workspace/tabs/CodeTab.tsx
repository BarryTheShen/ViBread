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
import type { RevisionDetail } from "@vibread/core";
import { useState } from "react";
import SyntaxHighlighter from "react-syntax-highlighter/dist/esm/prism-light";
import cpp from "react-syntax-highlighter/dist/esm/languages/prism/cpp";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import { MONO_FONT } from "../../theme.js";

SyntaxHighlighter.registerLanguage("cpp", cpp);

export function CodeTab({ revision }: { revision: RevisionDetail }) {
  const source = revision.circuit.sketch.source;
  const compile = revision.results.compile;
  const [copied, setCopied] = useState(false);
  const [showWarnings, setShowWarnings] = useState(false);
  const errors = compile?.diagnostics.filter((d) => d.severity === "error") ?? [];
  const warnings = compile?.diagnostics.filter((d) => d.severity === "warning") ?? [];
  const shown = [...errors, ...(showWarnings ? warnings : [])];

  return (
    <Stack sx={{ gap: 1.5 }}>
      <Stack direction="row" sx={{ gap: 1, alignItems: "center", flexWrap: "wrap" }}>
        <Typography variant="h3" component="h2" sx={{ flex: 1 }}>
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
      {warnings.length > 0 && (
        <Box>
          <Button size="small" onClick={() => setShowWarnings((v) => !v)} aria-expanded={showWarnings}>
            {showWarnings ? "Hide" : "Show"} {warnings.length} compiler warning{warnings.length === 1 ? "" : "s"} (the code still works)
          </Button>
        </Box>
      )}
      {shown.length > 0 && (
        <Alert severity={errors.length > 0 ? "error" : "warning"} sx={{ maxHeight: 260, overflow: "auto" }}>
          <List dense disablePadding>
            {shown.map((d, i) => (
              <ListItem key={i} disableGutters>
                <ListItemText
                  primary={d.message.split(/\\n|\n/)[0]}
                  secondary={`${d.file ? `${d.file.split("/").pop()} ` : ""}${d.line ? `line ${d.line}${d.column ? `:${d.column}` : ""} · ` : ""}${d.severity}`}
                  slotProps={{ primary: { sx: { fontFamily: MONO_FONT, fontSize: 12.5 } } }}
                />
              </ListItem>
            ))}
          </List>
        </Alert>
      )}
      <Box sx={{ borderRadius: 1, overflow: "hidden", border: 1, borderColor: "divider" }}>
        <SyntaxHighlighter
          language="cpp"
          style={vscDarkPlus}
          showLineNumbers
          customStyle={{ margin: 0, fontSize: 13, fontFamily: MONO_FONT, background: "#060a0e", maxHeight: "65vh" }}
          codeTagProps={{ style: { fontFamily: MONO_FONT } }}
        >
          {source}
        </SyntaxHighlighter>
      </Box>
    </Stack>
  );
}
