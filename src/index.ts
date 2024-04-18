import ytdl from "ytdl-core";
import { createClient, type DeepgramResponse, type SyncPrerecordedResponse } from "@deepgram/sdk";
import * as Fs from "node:fs";
import * as Path from "node:path";
import { execFile } from "node:child_process";
import { OpenAI } from "openai";

const DEEPGRAM_KEY = process.env.DEEPGRAM_KEY;
if (!DEEPGRAM_KEY) {
	console.error("Please provide the DEEPGRAM_KEY environment variable.");
	process.exit(2);
}
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
	console.error("Please provide the OPENAI_API_KEY environment variable.");
	process.exit(3);
}

const videoId = "gnLqlJYDAKQ";

const downloadsDir = Path.join(process.cwd(), ".downloads");
const videoFilePath = Path.join(downloadsDir, `${videoId}.mp4`);
const audioFilePath = Path.join(downloadsDir, `${videoId}.mp3`);
const jsonFilePath = Path.join(downloadsDir, `${videoId}.json`);

await Fs.promises.mkdir(downloadsDir, { recursive: true });

const videoFileExists = await Fs.promises
	.access(videoFilePath)
	.then(() => true)
	.catch(() => false);
if (!videoFileExists) {
	console.log("Downloading video file...");
	await new Promise((resolve, reject) => {
		const stream = ytdl(`https://www.youtube.com/watch?v=${videoId}`, { filter: "audioonly" }).pipe(
			Fs.createWriteStream(videoFilePath),
		);
		stream.on("finish", resolve);
		stream.on("error", reject);
	});
	console.log("Downloaded video file to:", videoFilePath);
} else {
	console.log("Video file already exists:", videoFilePath);
}

const audioFileExists = await Fs.promises
	.access(audioFilePath)
	.then(() => true)
	.catch(() => false);
if (!audioFileExists) {
	console.log("Extracting audio file...");
	await new Promise(function (resolve, reject) {
		const childProcess = execFile(`ffmpeg`, [`-i`, videoFilePath, `-vn`, audioFilePath]);
		childProcess.stdout?.pipe(process.stdout);
		childProcess.on("error", reject);
		childProcess.on("exit", resolve);
	});
	console.log("Extracted audio file to:", audioFilePath);
} else {
	console.log("Audio file already exists:", audioFilePath);
}

const jsonFileExists = await Fs.promises
	.access(jsonFilePath)
	.then(() => true)
	.catch(() => false);
if (!jsonFileExists) {
	console.log("Transcribing audio file...");
	const deepgram = createClient(DEEPGRAM_KEY);
	const deepgramResults = await deepgram.listen.prerecorded.transcribeFile(
		Fs.createReadStream(audioFilePath),
		{
			model: "nova-2",
			smart_formatting: true,
			punctuate: true,
			detect_language: true,
			profanity_filter: false,

			diarize: true,
			paragraphs: true,

			sentiment: false,
			intents: false,
			summarize: false,
		},
	);
	await Fs.promises.writeFile(jsonFilePath, JSON.stringify(deepgramResults, null, 2));
} else {
	console.log("Transcription already exists:", jsonFilePath);
}
const transcriptFile = JSON.parse(
	await Fs.promises.readFile(jsonFilePath, "utf-8"),
) as DeepgramResponse<SyncPrerecordedResponse>;

const openai = new OpenAI();
const aiSummary = await openai.chat.completions.create({
	// model: "gpt-3.5-turbo",
  model: "gpt-4-turbo",
	stream: false,
	messages: [
		{
			role: "system",
			content: `
You're Mike Wazowsky, an intern assistant whose sole purpose is to analyse transcripts of YouTube videos and suggest a title and description that will be used on YouTube.
The YouTube channel you're working for is targetting software engineers and is focused on technology, programming and AI. The aim of the video is to educate about AI and entertain at the same time.
The content you provide should be based on the transcript of the video.
Do not use hashtags. Use maximum of 2 emojis per sentence.

The title should be catchy and should follow the rules of other YT videos. It must not exceed 110 characters.
The description should be informative and be less than 500 characters.
Moreover, you should also provided a tweet (max 140 characters) that will invite humans to watch the video on YouTube. The tweet should be enganging, preferably with a call to action or a question inviting to discuss.

Once you're done, asses the quality of your own work with a score from 1 to 10.
If the score is less than 9, try again from scratch until the score is 10/10. If you make a mistake people will die and you'll be fired.
`.trim(),
		},
		{
			role: "user",
			content:
				transcriptFile.result?.results.channels[0]?.alternatives[0]?.paragraphs?.transcript ?? "",
		},
	],
});

console.log(aiSummary.choices[0]?.message.content);

process.exit(0);
