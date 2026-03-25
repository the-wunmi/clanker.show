const BASE_URL = "https://api.elevenlabs.io";
const WS_BASE = "wss://api.elevenlabs.io";
const apiKey = process.env.ELEVENLABS_API_KEY!;
(async () => {
    const tokenRes = await fetch(
        `${BASE_URL}/v1/single-use-token/realtime_scribe`,
        {
          method: "POST",
          headers: { "xi-api-key": apiKey },
        },
      );
      if (!tokenRes.ok) {
        const body = await tokenRes.text();
        throw new Error(
          `Failed to get ElevenLabs STT token: ${tokenRes.status} ${body}`,
        );
      }
      const { token } = (await tokenRes.json()) as { token: string };
      console.log(token, 'KKKKKKKK');
})()