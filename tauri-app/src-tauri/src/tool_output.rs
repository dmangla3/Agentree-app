use serde_json::Value as JsonValue;

pub(crate) const MAX_INLINE_TOOL_OUTPUT_BYTES: usize = 256 * 1024;
pub(crate) const TOOL_OUTPUT_TRUNCATION_NOTICE: &str =
    "\n\n[Output truncated. Refine the command.]\n\n";

fn floor_char_boundary(value: &str, mut index: usize) -> usize {
    index = index.min(value.len());
    while index > 0 && !value.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn ceil_char_boundary(value: &str, mut index: usize) -> usize {
    index = index.min(value.len());
    while index < value.len() && !value.is_char_boundary(index) {
        index += 1;
    }
    index
}

fn output_budgets() -> (usize, usize) {
    let content_budget =
        MAX_INLINE_TOOL_OUTPUT_BYTES.saturating_sub(TOOL_OUTPUT_TRUNCATION_NOTICE.len());
    let head_budget = content_budget / 2;
    (head_budget, content_budget - head_budget)
}

fn truncate_head_tail(value: &str) -> String {
    if value.len() <= MAX_INLINE_TOOL_OUTPUT_BYTES {
        return value.to_string();
    }
    let (head_budget, tail_budget) = output_budgets();
    let head_end = floor_char_boundary(value, head_budget);
    let tail_start = ceil_char_boundary(value, value.len().saturating_sub(tail_budget));
    let mut bounded = String::with_capacity(MAX_INLINE_TOOL_OUTPUT_BYTES);
    bounded.push_str(&value[..head_end]);
    bounded.push_str(TOOL_OUTPUT_TRUNCATION_NOTICE);
    bounded.push_str(&value[tail_start..]);
    bounded
}

fn truncate_concatenated_head_tail(current: &str, incoming: &str) -> String {
    let (head_budget, tail_budget) = output_budgets();
    let mut bounded = String::with_capacity(MAX_INLINE_TOOL_OUTPUT_BYTES);

    if current.len() >= head_budget {
        bounded.push_str(&current[..floor_char_boundary(current, head_budget)]);
    } else {
        bounded.push_str(current);
        let remaining = head_budget.saturating_sub(current.len());
        bounded.push_str(&incoming[..floor_char_boundary(incoming, remaining)]);
    }

    bounded.push_str(TOOL_OUTPUT_TRUNCATION_NOTICE);

    if incoming.len() >= tail_budget {
        let start = ceil_char_boundary(incoming, incoming.len().saturating_sub(tail_budget));
        bounded.push_str(&incoming[start..]);
    } else {
        let remaining = tail_budget.saturating_sub(incoming.len());
        let start = ceil_char_boundary(current, current.len().saturating_sub(remaining));
        bounded.push_str(&current[start..]);
        bounded.push_str(incoming);
    }
    bounded
}

pub(crate) fn bound_tool_output(value: &str) -> String {
    truncate_head_tail(value)
}

pub(crate) fn append_bounded_tool_output(current: &str, incoming: &str) -> String {
    if incoming.is_empty() {
        return bound_tool_output(current);
    }
    if current.is_empty() {
        return bound_tool_output(incoming);
    }

    if current.len() >= MAX_INLINE_TOOL_OUTPUT_BYTES.saturating_sub(8) {
        if current.contains(TOOL_OUTPUT_TRUNCATION_NOTICE) {
            return current.to_string();
        }
    }

    if incoming.starts_with(current) {
        return bound_tool_output(incoming);
    }
    if current.starts_with(incoming) || current.ends_with(incoming) {
        return bound_tool_output(current);
    }

    if current.len().saturating_add(incoming.len()) > MAX_INLINE_TOOL_OUTPUT_BYTES {
        return truncate_concatenated_head_tail(current, incoming);
    }

    format!("{current}{incoming}")
}

pub(crate) fn sanitize_tool_output_fields(value: &mut JsonValue) -> bool {
    match value {
        JsonValue::Array(values) => {
            let mut changed = false;
            for value in values {
                changed |= sanitize_tool_output_fields(value);
            }
            changed
        }
        JsonValue::Object(object) => {
            let is_tool_output_delta = object
                .get("type")
                .and_then(JsonValue::as_str)
                .map(|event_type| event_type == "tool_output_delta")
                .unwrap_or(false);
            let is_tool_result = object
                .get("type")
                .and_then(JsonValue::as_str)
                .map(|event_type| event_type == "tool_result")
                .unwrap_or(false);
            let mut changed = false;
            for (key, value) in object {
                let is_output_field = matches!(
                    key.as_str(),
                    "toolOutput" | "tool_output" | "aggregatedOutput" | "aggregated_output"
                ) || (is_tool_output_delta && key == "delta")
                    || (is_tool_result && matches!(key.as_str(), "output" | "content"));
                if is_output_field {
                    if let Some(output) = value.as_str() {
                        let bounded = bound_tool_output(output);
                        if bounded != output {
                            *value = JsonValue::String(bounded);
                            changed = true;
                        }
                        continue;
                    }
                }
                changed |= sanitize_tool_output_fields(value);
            }
            changed
        }
        _ => false,
    }
}

pub(crate) fn sanitize_serialized_tool_outputs(payload: &str) -> String {
    let has_output_field = [
        "\"toolOutput\"",
        "\"tool_output\"",
        "\"aggregatedOutput\"",
        "\"aggregated_output\"",
    ]
    .iter()
    .any(|key| payload.contains(key))
        || (payload.contains("\"type\":\"tool_output_delta\"") && payload.contains("\"delta\""))
        || (payload.contains("\"type\":\"tool_result\"")
            && (payload.contains("\"output\"") || payload.contains("\"content\"")));
    if !has_output_field {
        return payload.to_string();
    }
    let Ok(mut value) = serde_json::from_str::<JsonValue>(payload) else {
        return payload.to_string();
    };
    if !sanitize_tool_output_fields(&mut value) {
        return payload.to_string();
    }
    serde_json::to_string(&value).unwrap_or_else(|_| payload.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncation_is_utf8_safe_and_never_exceeds_the_limit() {
        let output = "🙂".repeat(MAX_INLINE_TOOL_OUTPUT_BYTES);
        let bounded = bound_tool_output(&output);

        assert!(bounded.len() <= MAX_INLINE_TOOL_OUTPUT_BYTES);
        assert!(bounded.contains("Output truncated. Refine the command."));
        assert!(bounded.starts_with('🙂'));
        assert!(bounded.ends_with('🙂'));
    }

    #[test]
    fn appending_stops_once_output_is_truncated() {
        let first = "a".repeat(200 * 1024);
        let second = "b".repeat(200 * 1024);
        let third = "c".repeat(32 * 1024);
        let truncated = append_bounded_tool_output(&first, &second);
        let bounded = append_bounded_tool_output(&truncated, &third);

        assert!(bounded.len() <= MAX_INLINE_TOOL_OUTPUT_BYTES);
        assert!(bounded.starts_with(&"a".repeat(64 * 1024)));
        assert!(bounded.ends_with(&"b".repeat(64 * 1024)));
        assert!(!bounded.contains(&third));
        assert_eq!(bounded.matches(TOOL_OUTPUT_TRUNCATION_NOTICE).count(), 1);
    }

    #[test]
    fn serialized_sanitizer_preserves_ordinary_payloads_exactly() {
        let payload = "{ \"type\": \"message\", \"content\": \"unchanged formatting\" }";
        assert_eq!(sanitize_serialized_tool_outputs(payload), payload);
    }
}
