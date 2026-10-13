import { Unit, UsageModelKind } from "@shared/core";

/** Standard synchronous rates for all three models, USD per token.
 * Pin each token, rather than rounding a receipt up to 1,000-token blocks.
 * Sources: each model's official pricing page and Monid's six inspect docs.
 * Batch and streaming are not exposed. The official image guide says cached
 * rates apply only to the Responses image tool, not direct Images API calls.
 */
export const imageUsageModel = {
    kind: UsageModelKind.COMPOSITE,
    components: {
        input_text_token: {
            kind: UsageModelKind.PER_UNIT,
            unit: Unit.TOKEN,
            label: "Input text tokens",
            description: "$5 per million input text tokens",
            consumes: { credit: "default", amount: 0.000005 },
        },
        input_image_token: {
            kind: UsageModelKind.PER_UNIT,
            unit: Unit.TOKEN,
            label: "Input image tokens",
            description: "$8 per million input image tokens",
            consumes: { credit: "default", amount: 0.000008 },
        },
        output_image_token: {
            kind: UsageModelKind.PER_UNIT,
            unit: Unit.TOKEN,
            label: "Output image tokens",
            description: "$30 per million output image tokens",
            consumes: { credit: "default", amount: 0.000030 },
        },
    },
} as const;
