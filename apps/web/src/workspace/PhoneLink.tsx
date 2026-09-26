import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Link from "@mui/material/Link";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { QRCodeSVG } from "qrcode.react";
import { usePhoneBuildLink } from "../api/hooks.js";

/** QR code + address for Build Mode on a phone (phone origin + LAN pairing query when the server hands one out). */
export function PhoneQr({ missionId, size = 120 }: { missionId: string; size?: number }) {
  const url = usePhoneBuildLink(missionId);
  return (
    <Stack direction="row" sx={{ gap: 2, alignItems: "center", flexWrap: "wrap" }}>
      {/* QR codes need a light quiet zone to scan, whatever the theme. */}
      <Box sx={{ bgcolor: "qr.main", p: 1, borderRadius: 1, lineHeight: 0 }}>
        <QRCodeSVG value={url} size={size} title="QR code for Build Mode on your phone" />
      </Box>
      <Box sx={{ flex: 1, minWidth: 180 }}>
        <Typography sx={{ fontWeight: 600 }}>Follow along on your phone</Typography>
        <Typography variant="body2" sx={{ color: "text.secondary", mb: 0.5 }}>
          Scan to open Build Mode: one step at a time, next to your breadboard. Flashing always stays on this laptop.
        </Typography>
        <Link href={url} sx={{ wordBreak: "break-all", fontSize: 13 }}>
          {url}
        </Link>
      </Box>
    </Stack>
  );
}

export function PhoneLinkDialog({ missionId, open, onClose }: { missionId: string; open: boolean; onClose(): void }) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Phone link</DialogTitle>
      <DialogContent>{open && <PhoneQr missionId={missionId} size={160} />}</DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
