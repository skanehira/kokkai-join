#!/usr/bin/env -S deno run -A

import { load } from "@std/dotenv";
import { Settings } from "npm:llamaindex";
import { Ollama, OllamaEmbedding } from "npm:@llamaindex/ollama";
import { Pool } from "npm:pg";
import pgvector from "npm:pgvector/pg";

interface SpeechResult {
	speechId: string;
	speaker: string;
	party: string;
	date: string;
	meeting: string;
	content: string;
	url: string;
	score: number;
}

interface KokkaiEntities {
	speakers?: string[]; // 議員名 (例: ["岸田文雄", "枝野幸男"])
	parties?: string[]; // 政党名 (例: ["自民党", "立憲民主党"])
	dateRange?: {
		// 期間指定
		start: string; // ISO日付文字列 "2024-01-01"
		end: string; // ISO日付文字列 "2024-12-31"
	};
	meetings?: string[]; // 会議名 (例: ["予算委員会", "法務委員会"])
	topics?: string[]; // 議題・キーワード (例: ["防衛費", "子育て支援"])
	positions?: string[]; // 役職 (例: ["総理大臣", "外務大臣"])
}

interface QueryPlan {
	originalQuestion: string; // 元の質問
	subqueries: string[]; // 分解されたサブクエリ
	entities: KokkaiEntities; // 抽出されたエンティティ
	enabledStrategies: string[]; // 使用する検索戦略 ["vector", "structured", "statistical"]
	confidence: number; // プラン信頼度 (0-1)
	estimatedComplexity: number; // 処理複雑度予測 (1-5)
}

interface DatabaseRow {
	speech_id: string;
	speaker: string | null;
	speaker_group: string | null;
	date: string | null;
	meeting_name: string | null;
	speech_text: string | null;
	speech_url: string | null;
	similarity_score: string;
}

class PersistentKokkaiRAGCLI {
	private dbPool: Pool | null = null;

	async initialize(): Promise<void> {
		// 環境変数読み込み
		await load({ export: true });

		const databaseUrl = Deno.env.get("DATABASE_URL");
		const ollamaBaseUrl =
			Deno.env.get("OLLAMA_BASE_URL") || "http://localhost:11434";

		if (!databaseUrl) {
			throw new Error("DATABASE_URL environment variable is required");
		}

		// Ollama設定
		try {
			Settings.embedModel = new OllamaEmbedding({
				model: "bge-m3",
				config: {
					host: ollamaBaseUrl,
				},
			});

			Settings.llm = new Ollama({
				model: "gpt-oss:20b",
				config: {
					host: ollamaBaseUrl,
				},
			});
		} catch (error) {
			throw new Error(
				`Failed to initialize Ollama: ${(error as Error).message}`,
			);
		}

		// データベース接続プール
		this.dbPool = new Pool({
			connectionString: databaseUrl,
			max: 10,
		});

		// pgvectorタイプ登録
		const client = await this.dbPool.connect();
		try {
			await pgvector.registerTypes(client);
		} finally {
			client.release();
		}

		console.log("🚀 Persistent Kokkai RAG CLI initialized successfully");
	}

	// 1. Planner（計画係）の実装
	async planKokkaiQuery(question: string): Promise<QueryPlan> {
		if (!Settings.llm) {
			throw new Error("LLM not initialized");
		}

		console.log("🧠 Planning query strategy...");

		const prompt = `国会議事録検索システムのプランナーとして、以下の質問を分析してください。

質問: "${question}"

以下のJSON形式で出力してください（\`\`\`json等は不要）：
{
  "subqueries": [
    "質問を効果的に検索するための分解されたサブクエリ1",
    "サブクエリ2"
  ],
  "entities": {
    "speakers": ["議員名があれば具体的に。総理→岸田文雄等"],
    "parties": ["政党名があれば"],
    "topics": ["主要キーワード", "関連語・同義語"],
    "meetings": ["特定の委員会や会議があれば"],
    "positions": ["役職があれば具体的に"],
    "dateRange": {"start": "YYYY-MM-DD", "end": "YYYY-MM-DD"}
  },
  "enabledStrategies": ["vector", "structured"],
  "confidence": 0.8,
  "estimatedComplexity": 2
}

ルール:
1. subqueriesは質問を効果的に分解したもの（1-3個）
2. entitiesは国会議事録検索に有効な情報のみ抽出
3. enabledStrategiesは["vector", "structured", "statistical"]から選択
4. confidenceは解析の信頼度(0-1)
5. estimatedComplexityは処理の複雑さ(1-5)

例：
質問「岸田総理の防衛費についての発言」
→ speakers: ["岸田文雄", "内閣総理大臣"]
→ topics: ["防衛費", "防衛予算", "防衛関係費", "国防費"]
→ subqueries: ["岸田総理 防衛費", "内閣総理大臣 防衛予算"]`;

		try {
			const response = await Settings.llm.complete({ prompt });
			const planText = response.text.trim();

			// JSONパース試行
			let planData;
			try {
				planData = JSON.parse(planText);
			} catch (parseError) {
				throw new Error(
					`Failed to parse LLM response as JSON: ${(parseError as Error).message}\nResponse: ${planText}`,
				);
			}

			// QueryPlan形式に変換
			const plan: QueryPlan = {
				originalQuestion: question,
				subqueries: planData.subqueries || [question],
				entities: {
					speakers: planData.entities?.speakers || [],
					parties: planData.entities?.parties || [],
					topics: planData.entities?.topics || [],
					meetings: planData.entities?.meetings || [],
					positions: planData.entities?.positions || [],
					dateRange: planData.entities?.dateRange,
				},
				enabledStrategies: planData.enabledStrategies || ["vector"],
				confidence: planData.confidence || 0.5,
				estimatedComplexity: planData.estimatedComplexity || 2,
			};

			console.log(`📋 Query plan created:`);
			console.log(`   Subqueries: ${plan.subqueries.length}`);
			console.log(`   Speakers: ${plan.entities.speakers?.length || 0}`);
			console.log(`   Topics: ${plan.entities.topics?.length || 0}`);
			console.log(`   Strategies: ${plan.enabledStrategies.join(", ")}`);
			console.log(`   Confidence: ${plan.confidence.toFixed(2)}`);

			return plan;
		} catch (error) {
			console.error("❌ Planning error:", error);
			throw error;
		}
	}

	// 構造化フィルタリング
	private async applyStructuredFilter(
		entities: KokkaiEntities,
	): Promise<string[]> {
		if (!this.dbPool) {
			throw new Error("Database not initialized");
		}

		const conditions = [];
		const params: any[] = [];

		// 議員名での絞り込み
		if (entities.speakers && entities.speakers.length > 0) {
			const speakerConditions = entities.speakers.map((_, i) => {
				const paramIndex = params.length + 1;
				params.push(`%${entities.speakers![i]}%`);
				return `(e.speaker ILIKE $${paramIndex})`;
			});
			conditions.push(`(${speakerConditions.join(" OR ")})`);
		}

		// 政党での絞り込み
		if (entities.parties && entities.parties.length > 0) {
			const partyConditions = entities.parties.map((_, i) => {
				const paramIndex = params.length + 1;
				params.push(`%${entities.parties![i]}%`);
				return `(e.speaker_group ILIKE $${paramIndex})`;
			});
			conditions.push(`(${partyConditions.join(" OR ")})`);
		}

		// 日付範囲での絞り込み
		if (entities.dateRange) {
			const startParam = params.length + 1;
			const endParam = params.length + 2;
			params.push(entities.dateRange.start, entities.dateRange.end);
			conditions.push(`(e.date >= $${startParam} AND e.date <= $${endParam})`);
		}

		if (conditions.length === 0) {
			return []; // フィルタ条件なし
		}

		const query = `
			SELECT DISTINCT e.speech_id 
			FROM kokkai_speech_embeddings e
			WHERE ${conditions.join(" AND ")}
			LIMIT 1000
		`;

		try {
			const result = await this.dbPool.query(query, params);
			console.log(
				`📋 Structured filter applied: ${result.rows.length} candidates`,
			);
			return result.rows.map((row: any) => row.speech_id);
		} catch (error) {
			console.error("❌ Structured filter error:", error);
			return [];
		}
	}

	// プランベースの検索実行
	async searchWithPlan(
		plan: QueryPlan,
		topK: number = 5,
	): Promise<SpeechResult[]> {
		if (!this.dbPool || !Settings.embedModel) {
			throw new Error("Database or embedding model not initialized");
		}

		console.log(`🔍 Executing search plan...`);

		try {
			let allResults: SpeechResult[] = [];

			// 各サブクエリを実行
			for (const subquery of plan.subqueries) {
				console.log(`🔎 Processing subquery: "${subquery}"`);

				// 拡張クエリ作成（トピック関連語を追加）
				let expandedQuery = subquery;
				if (plan.entities.topics && plan.entities.topics.length > 0) {
					expandedQuery = `${subquery} ${plan.entities.topics.join(" ")}`;
				}

				// ベクトル検索実行
				const queryEmbedding =
					await Settings.embedModel.getTextEmbedding(expandedQuery);

				let searchQuery: string;
				let queryParams: any[];

				// 構造化フィルタの適用
				if (plan.enabledStrategies.includes("structured")) {
					const candidateIds = await this.applyStructuredFilter(plan.entities);

					if (candidateIds.length > 0) {
						// 構造化フィルタ + ベクトル検索
						searchQuery = `
							SELECT 
								speech_id, speaker, speaker_group, date, meeting_name,
								speech_text, speech_url,
								(1 - (embedding <=> $1)) as similarity_score
							FROM kokkai_speech_embeddings
							WHERE speech_id = ANY($2::text[])
							  AND embedding <=> $1 < 0.8
							ORDER BY embedding <=> $1
							LIMIT $3
						`;
						queryParams = [pgvector.toSql(queryEmbedding), candidateIds, topK];
					} else {
						// フォールバック: ベクトル検索のみ
						searchQuery = `
							SELECT 
								speech_id, speaker, speaker_group, date, meeting_name,
								speech_text, speech_url,
								(1 - (embedding <=> $1)) as similarity_score
							FROM kokkai_speech_embeddings
							WHERE embedding <=> $1 < 0.6
							ORDER BY embedding <=> $1
							LIMIT $2
						`;
						queryParams = [pgvector.toSql(queryEmbedding), topK];
					}
				} else {
					// ベクトル検索のみ
					searchQuery = `
						SELECT 
							speech_id, speaker, speaker_group, date, meeting_name,
							speech_text, speech_url,
							(1 - (embedding <=> $1)) as similarity_score
						FROM kokkai_speech_embeddings
						WHERE embedding <=> $1 < 0.7
						ORDER BY embedding <=> $1
						LIMIT $2
					`;
					queryParams = [pgvector.toSql(queryEmbedding), topK];
				}

				const result = await this.dbPool.query(searchQuery, queryParams);

				// 結果をSpeechResult形式に変換
				const subqueryResults: SpeechResult[] = result.rows.map(
					(row: DatabaseRow) => ({
						speechId: row.speech_id,
						speaker: row.speaker || "未知の議員",
						party: row.speaker_group || "?",
						date: row.date || "2024-01-01",
						meeting: row.meeting_name || "?",
						content: row.speech_text || "",
						url: row.speech_url || "",
						score: parseFloat(row.similarity_score) || 0.0,
					}),
				);

				allResults = allResults.concat(subqueryResults);
			}

			// 重複除去とスコア順ソート
			const uniqueResults = Array.from(
				new Map(allResults.map((r) => [r.speechId, r])).values(),
			)
				.sort((a, b) => b.score - a.score)
				.slice(0, topK);

			console.log(
				`✅ Plan execution completed: ${uniqueResults.length} unique results`,
			);
			return uniqueResults;
		} catch (error) {
			console.error("❌ Plan search error:", error);
			throw error;
		}
	}

	// 従来の簡単な検索（後方互換性）
	async search(query: string, topK: number = 5): Promise<SpeechResult[]> {
		// プランナーを使用した検索に切り替え
		const plan = await this.planKokkaiQuery(query);
		return this.searchWithPlan(plan, topK);
	}

	async generateAnswer(
		query: string,
		results: SpeechResult[],
	): Promise<string> {
		if (!Settings.llm) {
			throw new Error("LLM not initialized");
		}

		// 検索結果をコンテキストとして整理
		const context = results
			.map(
				(result, index) =>
					`【発言 ${index + 1}】
議員: ${result.speaker} (${result.party})
日付: ${result.date}
会議: ${result.meeting}
内容: ${result.content}
出典: ${result.url}
関連度: ${result.score.toFixed(3)}
`,
			)
			.join("\n");

		const prompt = `以下の国会議事録から、質問に対して正確で詳細な回答を作成してください。

質問: ${query}

国会議事録:
${context}

回答要件:
1. 発言者名と所属政党を明記する
2. 発言の日付と会議名を含める
3. 具体的な内容を引用する
4. 出典URLを提示する
5. 複数の発言がある場合は比較・整理する際も、各要点に対応する出典URLを明記する
6. まとめ部分でも、根拠となった発言の出典URLを含める
7. 事実に基づいて回答し、推測は避ける

重要: 議論の比較・整理やまとめの各項目にも、必ず根拠となった発言の出典URL（例: https://kokkai.ndl.go.jp/txt/...）を併記してください。

回答:`;

		try {
			const response = await Settings.llm.complete({ prompt });
			return response.text;
		} catch (error) {
			console.error("❌ LLM generation error:", error);
			return `検索結果に基づく情報:

${results
	.map(
		(result, index) =>
			`${index + 1}. ${result.speaker} (${result.party})
   日付: ${result.date}
   会議: ${result.meeting}
   内容: ${result.content.substring(0, 300)}...
   出典: ${result.url}
   関連度: ${result.score.toFixed(3)}`,
	)
	.join("\n\n")}`;
		}
	}

	async close(): Promise<void> {
		if (this.dbPool) {
			await this.dbPool.end();
			console.log("📊 Database connection closed");
		}
	}

	formatResults(results: SpeechResult[]): void {
		console.log(`\n📋 Found ${results.length} results:\n`);

		results.forEach((result, index) => {
			console.log(`--- Result ${index + 1} ---`);
			console.log(`👤 Speaker: ${result.speaker} (${result.party})`);
			console.log(`📅 Date: ${result.date}`);
			console.log(`🏛️ Meeting: ${result.meeting}`);
			console.log(`⭐ Score: ${result.score.toFixed(3)}`);
			console.log(`🔗 URL: ${result.url}`);
			console.log(
				`💬 Content: ${result.content.substring(0, 300)}${
					result.content.length > 300 ? "..." : ""
				}`,
			);
			console.log("");
		});
	}

	async getStats(): Promise<void> {
		if (!this.dbPool) return;

		try {
			const totalResult = await this.dbPool.query(
				'SELECT COUNT(*) as count FROM "Speech"',
			);
			const embeddedResult = await this.dbPool.query(
				"SELECT COUNT(*) as count FROM kokkai_speech_embeddings",
			);

			console.log("\n📊 Database Statistics:");
			console.log(`Total speeches: ${totalResult.rows[0].count}`);
			console.log(`Embedded speeches: ${embeddedResult.rows[0].count}`);
			const percentage =
				(embeddedResult.rows[0].count / totalResult.rows[0].count) * 100;
			console.log(`Embedded percentage: ${percentage.toFixed(1)}%`);
		} catch (error) {
			console.error("Failed to get stats:", error);
		}
	}
}

async function main(): Promise<void> {
	const args = Deno.args;

	if (args.length === 0) {
		console.error(
			'❌ Usage: deno run -A scripts/persistent-rag-cli.ts "検索クエリ"',
		);
		console.error(
			'   Example: deno run -A scripts/persistent-rag-cli.ts "岸田総理の防衛費について"',
		);
		Deno.exit(1);
	}

	const query = args.join(" ");
	const ragCli = new PersistentKokkaiRAGCLI();

	try {
		await ragCli.initialize();
		await ragCli.getStats();

		// ベクトル検索実行
		const results = await ragCli.search(query);

		if (results.length === 0) {
			console.log("❌ No relevant speeches found.");
			return;
		}

		// 検索結果表示
		ragCli.formatResults(results);

		// LLMによる回答生成
		console.log("🤖 Generating AI answer...\n");
		const answer = await ragCli.generateAnswer(query, results);

		console.log("═".repeat(80));
		console.log("🎯 AI-Generated Answer:");
		console.log("═".repeat(80));
		console.log(answer);
		console.log("═".repeat(80));
	} catch (error) {
		console.error("❌ Error:", (error as Error).message);
		Deno.exit(1);
	} finally {
		await ragCli.close();
	}
}

if (import.meta.main) {
	await main();
}
