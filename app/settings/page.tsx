import SettingsForm from "@/components/SettingsForm";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  const s = getSettings();
  return (
    <SettingsForm
      initial={{
        light: s.light,
        quality: s.quality,
        embed: s.embed,
        summaryEveryTurns: s.summaryEveryTurns,
        wbMaxHits: s.wbMaxHits,
        vecTopK: s.vecTopK,
        ttsVoice: s.ttsVoice,
        ttsRate: s.ttsRate,
        ttsPitch: s.ttsPitch,
      }}
    />
  );
}
