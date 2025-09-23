// Query planning service for Kokkai RAG system

import { getOpenAIClient, resolveModel } from "../config/openai.ts";
import type { QueryPlan } from "../types/kokkai.ts";
import {
	createQueryPlanPrompt,
	getQueryPlanSystemPrompt,
} from "../utils/prompt.ts";

/**
 * クエリプランニングサービス。
 *
 * - 役割: ユーザ質問を解析し、検索に適したサブクエリやエンティティ（話者/政党/期間など）を抽出。
 * - 本実装: OpenAI 経由で選択した LLM にプロンプトして JSON 形式のプランを生成する。
 */
export class QueryPlanningService {
	/** ユーザ質問からクエリプラン（サブクエリ等）を生成 */
	async createQueryPlan(userQuestion: string): Promise<QueryPlan> {
		console.log("🧠 Planning query strategy...");

		const userPrompt = createQueryPlanPrompt(userQuestion);

		try {
			const client = getOpenAIClient();
			const completion = await client.chat.completions.create({
				messages: [
					{ role: "system", content: getQueryPlanSystemPrompt() },
					{ role: "user", content: userPrompt },
				],
				model: resolveModel("query_planning"),
				max_tokens: 3000,
				temperature: 0.3, // 計画生成は確定的に
				stream: false,
			});

			const planText = completion.choices[0]?.message?.content?.trim();
			if (!planText) {
				throw new Error("No text in completion response");
			}

			// JSONパース試行
			let planData;
			try {
				planData = JSON.parse(planText);
			} catch (parseError) {
				throw new Error(
					`Failed to parse LLM response as JSON: ${
						(parseError as Error).message
					}\nResponse: ${planText}`,
				);
			}

			// QueryPlan形式に変換
			const plan: QueryPlan = {
				originalQuestion: userQuestion,
				subqueries: planData.subqueries || [userQuestion],
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
			console.log(`   Original Question: ${JSON.stringify(plan)}`);
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
}
