import ytdl from "ytdl-core";
import { createClient, type DeepgramResponse, type SyncPrerecordedResponse } from "@deepgram/sdk";
import * as Fs from "node:fs";
import * as Path from "node:path";
import { execFile } from "node:child_process";
import { OpenAI } from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/index.mjs";

const [videoId, ...keyPoints] = process.argv.slice(2);
const keyPoint = keyPoints.join(" ").trim();

if (!videoId) {
	console.error("Please provide the video ID as the first argument.");
	process.exit(1);
}

const DEEPGRAM_KEY = process.env.DEEPGRAM_KEY;
if (!DEEPGRAM_KEY) {
	console.error("Please provide the DEEPGRAM_KEY environment variable.");
	process.exit(2);
}

const OLLAMA_URL = process.env.OLLAMA_URL;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OLLAMA_URL && !OPENAI_API_KEY) {
	console.error("Please provide the OPENAI_API_KEY or OLLAMA_URL environment variable.");
	process.exit(3);
}

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
	if (deepgramResults.error) {
		console.error("Deepgram error:", deepgramResults.error);
		process.exit(4);
	}

	await Fs.promises.writeFile(jsonFilePath, JSON.stringify(deepgramResults, null, 2));
	console.log("Transcribed audio file to:", jsonFilePath);
} else {
	console.log("Transcription already exists:", jsonFilePath);
}

const transcriptFile = JSON.parse(
	await Fs.promises.readFile(jsonFilePath, "utf-8"),
) as DeepgramResponse<SyncPrerecordedResponse>;

console.log(`Asking AI to summarize the video...`);

// const messages = [
// 	{
// 		role: "user",
// 		content: `
// You're Mike Wazowsky, an intern assistant whose sole purpose is to analyse transcripts of YouTube videos and suggest a title and description that will be used on YouTube.
// The YouTube channel you're working for is targetting software engineers and is focused on technology, programming and AI. The aim of the video is to educate about AI and entertain at the same time.
// The content you provide should be based on the transcript of the video.
// ${keyPoint ? `The most important point in this video is: ${keyPoint}. Make sure to mention it.` : ""}
// Do not use hashtags. Use maximum of 2 emojis per sentence. Keep the language simple and engaging. Never use the word "delve".

// The title should be catchy and should follow the rules of other YT videos. It must not exceed 110 characters.
// The description should be informative and be less than 500 characters.
// Moreover, you should also provided a tweet (max 140 characters) that will invite humans to watch the video on YouTube. The tweet should be enganging, preferably with a call to action or a question inviting to discuss.

// Once you're done, asses the quality of your own work with a score from 1 to 10.
// If the score is less than 9, try again from scratch until the score is 10/10. If you make a mistake you'll be fired.

// The video transcript:
// ${transcriptFile.result?.results.channels[0]?.alternatives[0]?.paragraphs?.transcript ?? ""}
// `.trim(),
// 	},
// ] as ChatCompletionMessageParam[];

const baseMessages = [
	{
		role: "system",
		content: `
You're a senior content manager whose sole purpose is to analyse transcripts of YouTube videos and create marketing content that will be used to promote the video on social media.
The YouTube channel you're working for is targetting software engineers and is focused on technology, programming and AI. The aim of the video is to educate about AI.
The content you provide should be based on the transcript of the video as well as your prior knowledge.
${keyPoint ? `The most important point in this video is: ${keyPoint}. Make sure to mention it.` : ""}

${true ? 'Pick a quote from this transcript that you think is the most engaging and informative. Use it in the content you create.' : ''}
Create a 140 characters long tweet: it should be engaging and invite humans to watch the video on YouTube, preferably with a call to action or a question inviting to discuss. The tweet should follow all rules of Twitter.
Create a 500 characters long LinkedIn Post: it should be informative and engaging, and invite humans to watch the video on YouTube, preferably with a call to action or a question inviting to discuss. The post should follow all rules of LinkedIn.
Do not use hashtags. Use maximum of 2 emojis per sentence. Keep the language simple and engaging. Never use the word "delve".
Make sure the Tweet is never shorter than 120 characters.
Make sure the linkedin post is never shorter than 400 characters.

Once you're done, asses the quality of your own work with a score from 1 to 10. Take into account the goal of the content you're creating: attracting people and promoting software engineering and AI engineering. List things that you think could be improved.

If you make a mistake people will die and you'll be fired.

Return response in JSON format { quote: string, tweet: string, linkedin: string, score: number, improvements: string[] }.
`.trim(),
	},
	// If the score is less than 9, try again from scratch until the score is 10/10. If you make a mistake you'll be fired.
	{
		role: "user",
		content:
			transcriptFile.result?.results.channels[0]?.alternatives[0]?.paragraphs?.transcript.trim(),
	}
] as ChatCompletionMessageParam[];

if (OPENAI_API_KEY) {
	console.log("Sending to OpenAI...");

	const messages = [...baseMessages];
	for (let i = 0; i < 2; i++) {
		const openai = new OpenAI();
		const aiResponse = await openai.chat.completions.create({
			// model: "gpt-3.5-turbo",
			model: "gpt-4-turbo",
			stream: false,
			response_format: {
				type: "json_object",
			},
			messages,
		});
		const json = JSON.parse(aiResponse.choices[0]!.message.content!) as {
			quote: string;
			tweet: string;
			linkedin: string;
			score: number;
			improvements: string[];
		};
		console.log(json);

		if (json.score >= 10 || json.improvements.length === 0) {
			console.log("Success!");
			break;
		}
		messages.push({
			role: "assistant",
			content: aiResponse.choices[0]!.message.content!,
		})
		messages.push({
			role: "user",
			content: [...json.improvements.map(improvement => `- ${improvement}`),
				"Do not use hashtags.",
				"Make sure the linkedin post is between 400 and 500 characters.",
				"Make sure the tweet is between more than 130 characters.",
				"Do not use the word 'delve'.",
			].join("\n"),
		})
	}
}

process.exit(0);
