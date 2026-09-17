use serde_json::{Map as JsonMap, Value as JsonValue};

pub fn artifact_id(artifact: &JsonValue) -> Option<&str> {
    artifact.get("id").and_then(|value| value.as_str())
}

pub fn set_artifact_primary_flag(artifact: &mut JsonValue, is_primary: bool) {
    if let Some(object) = artifact.as_object_mut() {
        object.remove("is_primary");
        object.insert("isPrimary".to_string(), JsonValue::Bool(is_primary));
    }
}

pub fn upsert_artifact_in_execution_data(
    execution_data: &mut JsonValue,
    mut artifact: JsonValue,
) -> (Vec<JsonValue>, JsonValue) {
    if !execution_data.is_object() {
        *execution_data = JsonValue::Object(JsonMap::new());
    }

    let Some(execution_object) = execution_data.as_object_mut() else {
        return (Vec::new(), artifact);
    };

    let mut artifacts = execution_object
        .get("artifacts")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();

    if let Some(new_id) = artifact_id(&artifact) {
        artifacts.retain(|existing| artifact_id(existing) != Some(new_id));
    }

    let should_mark_primary = artifact
        .get("isPrimary")
        .or_else(|| artifact.get("is_primary"))
        .and_then(|value| value.as_bool())
        .unwrap_or_else(|| artifacts.is_empty());

    if should_mark_primary {
        for existing in artifacts.iter_mut() {
            set_artifact_primary_flag(existing, false);
        }
        set_artifact_primary_flag(&mut artifact, true);
    }

    let upserted_artifact = artifact.clone();
    artifacts.push(artifact);
    execution_object.insert("artifacts".to_string(), JsonValue::Array(artifacts.clone()));
    (artifacts, upserted_artifact)
}

#[cfg(test)]
mod tests {
    use super::upsert_artifact_in_execution_data;
    use serde_json::json;

    #[test]
    fn upsert_removes_snake_case_primary_from_demoted_artifacts() {
        let mut execution_data = json!({
            "artifacts": [{
                "id": "old-artifact",
                "kind": "image",
                "mimeType": "image/png",
                "is_primary": true
            }]
        });

        let (artifacts, upserted) = upsert_artifact_in_execution_data(
            &mut execution_data,
            json!({
                "id": "new-artifact",
                "kind": "image",
                "mimeType": "image/png",
                "is_primary": true
            }),
        );

        assert_eq!(artifacts[0]["isPrimary"], json!(false));
        assert!(artifacts[0].get("is_primary").is_none());
        assert_eq!(artifacts[1]["isPrimary"], json!(true));
        assert!(artifacts[1].get("is_primary").is_none());
        assert_eq!(upserted["isPrimary"], json!(true));
        assert!(upserted.get("is_primary").is_none());
    }
}
