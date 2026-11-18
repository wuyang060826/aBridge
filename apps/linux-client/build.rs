use std::{env, fs, path::PathBuf};
fn main() {
    println!("cargo:rerun-if-env-changed=ABRIDGE_CONTRACT_PATH");
    let source = env::var("ABRIDGE_CONTRACT_PATH")
        .expect("Build via npm run linux:build to generate the shared protocol contract");
    println!("cargo:rerun-if-changed={source}");
    let bytes = fs::read(source).expect("Read generated contract");
    let contract: serde_json::Value = serde_json::from_slice(&bytes).expect("Valid contract JSON");
    println!(
        "cargo:rustc-env=ABRIDGE_VERSION={}",
        contract["version"].as_str().expect("Product version")
    );
    fs::write(
        PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("contract.json"),
        bytes,
    )
    .unwrap();
}
