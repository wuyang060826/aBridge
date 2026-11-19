fn main() {
    println!("cargo:rerun-if-env-changed=ABRIDGE_VERSION");
    println!("cargo:rerun-if-env-changed=ABRIDGE_ICON");
    println!("cargo:rerun-if-changed=app.manifest");
    let package: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string("../../../package.json").expect("root package.json"),
    )
    .expect("root metadata");
    let version = package["version"]
        .as_str()
        .expect("root version")
        .to_string();
    println!("cargo:rerun-if-changed=../../../package.json");
    let mut resource = winresource::WindowsResource::new();
    let mut parts = version
        .split(['.', '-'])
        .take(3)
        .map(|part| part.parse::<u64>().expect("numeric version"));
    let numeric = (parts.next().unwrap_or(0) << 48)
        | (parts.next().unwrap_or(0) << 32)
        | (parts.next().unwrap_or(0) << 16);
    resource
        .set_version_info(winresource::VersionInfo::FILEVERSION, numeric)
        .set_version_info(winresource::VersionInfo::PRODUCTVERSION, numeric);
    resource
        .set("ProductName", "aBridge")
        .set("FileDescription", "aBridge")
        .set("ProductVersion", &version)
        .set("FileVersion", &version)
        .set_manifest_file("app.manifest");
    if let Ok(icon) = std::env::var("ABRIDGE_ICON") {
        resource.set_icon(&icon);
    }
    println!("cargo:rerun-if-env-changed=ABRIDGE_WINUI_MANIFEST");
    let bundle = std::env::var("ABRIDGE_WINUI_MANIFEST")
        .ok()
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap())
                .ancestors()
                .nth(3)
                .unwrap()
                .join("naui-winappsdk/naui-winappsdk.manifest")
        });
    println!("cargo:rerun-if-changed={}", bundle.display());
    if bundle.exists() {
        let sdk = std::fs::read_to_string(&bundle).expect("WinUI runtime manifest");
        let start = sdk.find("<asmv3:file").expect("WinUI file declarations");
        let end = sdk.rfind("</assembly>").expect("WinUI assembly end");
        let base = std::fs::read_to_string("app.manifest").expect("app manifest");
        let merged = base.replace("<assembly manifestVersion", "<assembly xmlns:asmv3='urn:schemas-microsoft-com:asm.v3' xmlns:winrtv1='urn:schemas-microsoft-com:winrt.v1' manifestVersion").replace("</assembly>", &format!("{}\n</assembly>", &sdk[start..end]));
        let path =
            std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("app-winui.manifest");
        std::fs::write(&path, merged).expect("combined app manifest");
        resource.set_manifest_file(path.to_str().unwrap());
    }
    resource.compile().expect("Windows resources");
}
