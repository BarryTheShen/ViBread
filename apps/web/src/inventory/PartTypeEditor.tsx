import CloseIcon from "@mui/icons-material/Close";
import DeleteOutlineOutlinedIcon from "@mui/icons-material/DeleteOutlineOutlined";
import AddIcon from "@mui/icons-material/Add";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControl from "@mui/material/FormControl";
import FormControlLabel from "@mui/material/FormControlLabel";
import FormLabel from "@mui/material/FormLabel";
import IconButton from "@mui/material/IconButton";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Radio from "@mui/material/Radio";
import RadioGroup from "@mui/material/RadioGroup";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import {
  ELECTRICAL_TYPES,
  MODULES,
  PART_CATEGORIES,
  type CatalogView,
  type ElectricalType,
  type FieldKind,
  type ModulePin,
  type PartCategory,
  type PartField,
  type PartType,
} from "@vibread/core";
import { useEffect, useMemo, useState } from "react";
import { useCreatePartType } from "../api/inventory.js";

export interface PartTypeEditorProps {
  open: boolean;
  catalog: CatalogView | undefined;
  onClose(): void;
  onSaved?(type: PartType): void;
  source?: PartType;
}

type TreatAs = "modelled" | "basic" | "list-only";

type EditableField = PartField & { optionsText: string };

const CATEGORY_LABELS: Record<PartCategory, string> = {
  lights: "Lights",
  resistors: "Resistors",
  switches: "Switches",
  sensors: "Sensors",
  sound: "Sound",
  displays: "Displays",
  motors: "Motors",
  semiconductors: "Semiconductors",
  passives: "Passives",
  modules: "Modules",
  board: "Board",
  supplies: "Supplies",
  other: "Other",
};

const KIND_LABELS: Record<FieldKind, string> = { choice: "Choice list", number: "Number", boolean: "Yes / no", text: "Text" };

function editableFields(type: PartType | undefined): EditableField[] {
  return (type?.fields ?? []).map((field) => ({ ...field, optionsText: field.options?.join(", ") ?? "" }));
}

function pinsForTemplate(template: string): ModulePin[] {
  if (template === "2-pin switch") {
    return [
      { id: "1", name: "signal 1", etype: "passive" },
      { id: "2", name: "signal 2", etype: "passive" },
    ];
  }
  if (template === "3-pin module VCC/GND/OUT") {
    return [
      { id: "VCC", name: "VCC", etype: "power_in" },
      { id: "GND", name: "GND", etype: "power_in", polarity: "-" },
      { id: "OUT", name: "OUT", etype: "output" },
    ];
  }
  if (template === "2-lead part") {
    return [
      { id: "1", name: "lead 1", etype: "passive" },
      { id: "2", name: "lead 2", etype: "passive" },
    ];
  }
  return [];
}
function normalizedPinout(pins: ModulePin[]): ModulePin[] {
  const used = new Set<string>();
  return pins.map((pin, index) => {
    const base = pin.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `pin-${index + 1}`;
    let id = base;
    let suffix = 2;
    while (used.has(id)) id = `${base}-${suffix++}`;
    used.add(id);
    return { ...pin, id };
  });
}

function modulePinCount(type: PartType): number {
  if (type.pinout) return type.pinout.length;
  if (type.mapping.kind === "module" || type.mapping.kind === "modelled") return MODULES[type.mapping.module].pins.length;
  return 0;
}

function resetType(type: PartType | undefined) {
  return {
    name: type?.name ?? "",
    category: type?.category ?? ("other" as PartCategory),
    aliases: type?.aliases.join(", ") ?? "",
    photoHint: type?.photoHint ?? "",
    description: type?.description ?? "",
    fields: editableFields(type),
    treat: (type?.mapping.kind === "module" || type?.mapping.kind === "modelled" ? "modelled" : type?.mapping.kind === "generic" ? "basic" : "list-only") as TreatAs,
    targetTypeId: type?.mapping.kind === "module" || type?.mapping.kind === "modelled" ? type.id : "",
    role: type?.mapping.kind === "generic" ? type.mapping.role : "analog-sensor",
    template: type?.pinout?.length === 3 ? "3-pin module VCC/GND/OUT" : type?.pinout?.length === 2 ? "2-lead part" : "custom",
    pinout: type?.pinout ?? [],
  };
}

export function PartTypeEditor({ open, catalog, onClose, onSaved, source }: PartTypeEditorProps) {
  const create = useCreatePartType();
  const [startFrom, setStartFrom] = useState(source ? "__source" : "");
  const [name, setName] = useState("");
  const [category, setCategory] = useState<PartCategory>("other");
  const [aliases, setAliases] = useState("");
  const [photoHint, setPhotoHint] = useState("");
  const [description, setDescription] = useState("");
  const [fields, setFields] = useState<EditableField[]>([]);
  const [treat, setTreat] = useState<TreatAs>("list-only");
  const [targetTypeId, setTargetTypeId] = useState("");
  const [role, setRole] = useState<"digital-sensor" | "analog-sensor" | "digital-actuator">("analog-sensor");
  const [template, setTemplate] = useState("custom");
  const [pinout, setPinout] = useState<ModulePin[]>([]);
  const [validation, setValidation] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const state = resetType(source);
    setName(state.name);
    setCategory(state.category);
    setAliases(state.aliases);
    setPhotoHint(state.photoHint);
    setDescription(state.description);
    setFields(state.fields);
    setTreat(state.treat);
    setTargetTypeId(state.targetTypeId);
    setRole(state.role);
    setTemplate(state.template);
    setPinout(state.pinout);
    setStartFrom(source ? "__source" : "");
    setValidation(null);
    create.reset();
  }, [open, source]);

  const targets = useMemo(() => {
    const all = catalog?.types ?? [];
    const count = pinout.length;
    return all.filter((type) => {
      if (!type.builtIn || (type.mapping.kind !== "module" && type.mapping.kind !== "modelled")) return false;
      return count === 0 || modulePinCount(type) === count;
    });
  }, [catalog?.types, pinout.length]);
  const applyStartFrom = (id: string) => {
    const selected = id === "__source" ? source : catalog?.types.find((type) => type.id === id);
    const state = resetType(selected);
    setStartFrom(id);
    setName(state.name);
    setCategory(state.category);
    setAliases(state.aliases);
    setPhotoHint(state.photoHint);
    setDescription(state.description);
    setFields(state.fields);
    setTreat(state.treat);
    setTargetTypeId(state.targetTypeId);
    setRole(state.role);
    setTemplate(state.template);
    setPinout(state.pinout);
  };

  const updateField = (index: number, patch: Partial<EditableField>) => {
    setFields((current) => current.map((field, i) => (i === index ? { ...field, ...patch } : field)));
  };

  const save = () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setValidation("Give this part type a name.");
      return;
    }
    const seen = new Set<string>();
    const normalizedFields: PartField[] = [];
    for (const [index, field] of fields.entries()) {
      const label = field.label.trim() || `Field ${index + 1}`;
      const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `field-${index + 1}`;
      let key = base;
      let suffix = 2;
      while (seen.has(key)) key = `${base}-${suffix++}`;
      seen.add(key);
      normalizedFields.push({
        key,
        label,
        kind: field.kind,
        ...(field.unit?.trim() ? { unit: field.unit?.trim() } : {}),
        ...(field.kind === "choice" && field.optionsText.trim() ? { options: field.optionsText.split(",").map((option) => option.trim()).filter(Boolean) } : {}),
        ...(field.min !== undefined ? { min: field.min } : {}),
        ...(field.max !== undefined ? { max: field.max } : {}),
        identity: field.identity,
        electrical: field.electrical,
        ...(field.required ? { required: true } : {}),
      });
    }
    if (treat === "modelled" && !targets.some((candidate) => candidate.id === targetTypeId)) {
      setValidation("Choose a pin-compatible built-in part to model this type as.");
      return;
    }

    const mapping =
      treat === "modelled"
        ? { kind: "modelled" as const, module: (targets.find((candidate) => candidate.id === targetTypeId)?.mapping as { kind: "module" | "modelled"; module: keyof typeof MODULES } | undefined)?.module ?? "photoresistor" }
        : treat === "basic"
          ? { kind: "generic" as const, role }
          : { kind: "note" as const };
    const normalizedPins = normalizedPinout(pinout);
    const payload: Omit<PartType, "id" | "builtIn"> = {
      name: trimmedName,
      category,
      aliases: aliases.split(",").map((alias) => alias.trim()).filter(Boolean),
      photoHint: photoHint.trim() || `${trimmedName} part`,
      description: description.trim() || `A user-defined ${trimmedName}.`,
      fields: normalizedFields,
      support: treat,
      mapping,
      ...(treat === "basic" && normalizedPins.length > 0 ? { pinout: normalizedPins } : {}),
    };
    create.mutate(payload, {
      onSuccess: (saved) => {
        onSaved?.(saved);
        onClose();
      },
    });
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md" scroll="paper" aria-labelledby="part-type-editor-title">
      <DialogTitle id="part-type-editor-title" sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        New part type
        <IconButton aria-label="Close" onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={3}>
          <FormControl fullWidth>
            <InputLabel id="part-type-start-label">Start from</InputLabel>
            <Select labelId="part-type-start-label" label="Start from" value={startFrom} onChange={(event) => applyStartFrom(event.target.value)}>
              <MenuItem value="">Blank</MenuItem>
              {source ? <MenuItem value="__source">Scan crop · {source.name}</MenuItem> : null}
              {(catalog?.types ?? []).filter((type) => type.builtIn).map((type) => <MenuItem key={type.id} value={type.id}>Copy {type.name}</MenuItem>)}
            </Select>
          </FormControl>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
            <TextField label="Name" value={name} onChange={(event) => setName(event.target.value)} required fullWidth autoFocus />
            <FormControl fullWidth>
              <InputLabel id="part-type-category-label">Category</InputLabel>
              <Select labelId="part-type-category-label" label="Category" value={category} onChange={(event) => setCategory(event.target.value as PartCategory)}>
                {PART_CATEGORIES.map((value) => (
                  <MenuItem key={value} value={value}>
                    {CATEGORY_LABELS[value]}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Stack>
          <TextField label="Also called" helperText="Names people might type or see on the package, separated by commas" value={aliases} onChange={(event) => setAliases(event.target.value)} fullWidth />
          <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
            <TextField label="How to recognise it in a photo" value={photoHint} onChange={(event) => setPhotoHint(event.target.value)} fullWidth />
            <TextField label="Description" value={description} onChange={(event) => setDescription(event.target.value)} fullWidth />
          </Stack>

          <Box>
            <Stack direction="row" sx={{ mb: 1, justifyContent: "space-between", alignItems: "center" }}>
              <FormLabel component="legend">Fields</FormLabel>
              <Button
                size="small"
                startIcon={<AddIcon />}
                onClick={() => setFields((current) => [...current, { key: `field${current.length + 1}`, label: "New field", kind: "text", identity: true, electrical: false, optionsText: "" }])}
              >
                Add field
              </Button>
            </Stack>
            <Stack spacing={1.5}>
              {fields.map((field, index) => (
                <Box key={`${field.key}-${index}`} sx={{ border: 1, borderColor: "divider", borderRadius: 1, p: 1.5 }}>
                  <Stack direction={{ xs: "column", md: "row" }} spacing={1} sx={{ alignItems: { md: "center" } }}>
                    <TextField label="Name" value={field.label} size="small" onChange={(event) => updateField(index, { label: event.target.value })} sx={{ minWidth: 150, flex: 1 }} />
                    <FormControl size="small" sx={{ minWidth: 140 }}>
                      <InputLabel id={`field-kind-${index}`}>Kind</InputLabel>
                      <Select labelId={`field-kind-${index}`} label="Kind" value={field.kind} onChange={(event) => updateField(index, { kind: event.target.value as FieldKind })}>
                        {(Object.keys(KIND_LABELS) as FieldKind[]).map((kind) => (
                          <MenuItem key={kind} value={kind}>{KIND_LABELS[kind]}</MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                    <TextField label={field.kind === "choice" ? "Values (comma separated)" : "Unit"} value={field.kind === "choice" ? field.optionsText : field.unit ?? ""} size="small" onChange={(event) => updateField(index, field.kind === "choice" ? { optionsText: event.target.value } : { unit: event.target.value })} sx={{ minWidth: 180, flex: 1 }} />
                    <IconButton aria-label={`Remove ${field.label}`} color="error" onClick={() => setFields((current) => current.filter((_, i) => i !== index))}>
                      <DeleteOutlineOutlinedIcon />
                    </IconButton>
                  </Stack>
                  <Stack direction="row" spacing={2} sx={{ mt: 0.5 }}>
                    <FormControlLabel control={<Checkbox checked={field.identity} onChange={(event) => updateField(index, { identity: event.target.checked })} />} label="Different value = different part" />
                    <FormControlLabel control={<Checkbox checked={field.electrical} onChange={(event) => updateField(index, { electrical: event.target.checked })} />} label="Changes electronics" />
                    <FormControlLabel control={<Checkbox checked={field.required ?? false} onChange={(event) => updateField(index, { required: event.target.checked })} />} label="Required" />
                  </Stack>
                </Box>
              ))}
              {fields.length === 0 ? <Typography color="text.secondary">Add fields such as colour, resistance, or package size.</Typography> : null}
            </Stack>
          </Box>

          <Box>
            <FormLabel component="legend">Treat as</FormLabel>
            <RadioGroup value={treat} onChange={(event) => setTreat(event.target.value as TreatAs)}>
              <FormControlLabel value="modelled" control={<Radio />} label="Works like a built-in part" />
              {treat === "modelled" ? (
                <FormControl size="small" sx={{ ml: 4, maxWidth: 420 }}>
                  <InputLabel id="modelled-target-label">Modelled as</InputLabel>
                  <Select labelId="modelled-target-label" label="Modelled as" value={targetTypeId} onChange={(event) => setTargetTypeId(event.target.value)}>
                    {targets.length === 0 ? <MenuItem value="">No pin-compatible built-ins found</MenuItem> : null}
                    {targets.map((type) => <MenuItem key={type.id} value={type.id}>{type.name}</MenuItem>)}
                  </Select>
                </FormControl>
              ) : null}
              <FormControlLabel value="basic" control={<Radio />} label="My pins — basic, with limits" />
              {treat === "basic" ? (
                <Stack spacing={1} sx={{ ml: 4, maxWidth: 560 }}>
                  <FormControl size="small">
                    <InputLabel id="pin-template-label">Pin template</InputLabel>
                    <Select
                      labelId="pin-template-label"
                      label="Pin template"
                      value={template}
                      onChange={(event) => {
                        const next = event.target.value;
                        setTemplate(next);
                        if (next !== "custom") setPinout(pinsForTemplate(next));
                      }}
                    >
                      <MenuItem value="2-pin switch">2-pin switch</MenuItem>
                      <MenuItem value="3-pin module VCC/GND/OUT">3-pin module VCC/GND/OUT</MenuItem>
                      <MenuItem value="2-lead part">2-lead part</MenuItem>
                      <MenuItem value="custom">Custom pin list</MenuItem>
                    </Select>
                  </FormControl>
                  {template === "custom" ? <Button size="small" startIcon={<AddIcon />} onClick={() => setPinout((current) => [...current, { id: `pin-${current.length + 1}`, name: `Pin ${current.length + 1}`, etype: "passive" }])}>Add pin</Button> : null}
                  {pinout.map((pin, index) => (
                    <Stack key={pin.id} direction={{ xs: "column", sm: "row" }} spacing={1}>
                      <TextField label="Pin name" value={pin.name} size="small" onChange={(event) => setPinout((current) => current.map((item, i) => i === index ? { ...item, name: event.target.value } : item))} />
                      <FormControl size="small" sx={{ minWidth: 180 }}>
                        <InputLabel id={`pin-type-${index}`}>Electrical type</InputLabel>
                        <Select labelId={`pin-type-${index}`} label="Electrical type" value={pin.etype} onChange={(event) => setPinout((current) => current.map((item, i) => i === index ? { ...item, etype: event.target.value as ElectricalType } : item))}>
                          {ELECTRICAL_TYPES.map((type) => <MenuItem key={type} value={type}>{type}</MenuItem>)}
                        </Select>
                      </FormControl>
                    </Stack>
                  ))}
                </Stack>
              ) : null}
              <FormControlLabel value="list-only" control={<Radio />} label="Just keep it in my list — Claude won't design with it yet" />
            </RadioGroup>
          </Box>
          {validation ? <Alert severity="warning">{validation}</Alert> : null}
          {create.error ? <Alert severity="error">{create.error instanceof Error ? create.error.message : "Could not save this part type."}</Alert> : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={save} disabled={create.isPending}>{create.isPending ? "Saving…" : "Save type"}</Button>
      </DialogActions>
    </Dialog>
  );
}

export default PartTypeEditor;
