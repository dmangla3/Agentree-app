use std::path::Path;

fn main() {
    let mut args = std::env::args().skip(1);
    let component = args.next().unwrap_or_else(|| {
        eprintln!("usage: runtime-fingerprint <component> <archive.tar.gz>");
        std::process::exit(2);
    });
    let archive_path = args.next().unwrap_or_else(|| {
        eprintln!("usage: runtime-fingerprint <component> <archive.tar.gz>");
        std::process::exit(2);
    });
    if args.next().is_some() {
        eprintln!("usage: runtime-fingerprint <component> <archive.tar.gz>");
        std::process::exit(2);
    }

    match agentree_lib::runtime_archive::archive_tree_sha256(Path::new(&archive_path), &component) {
        Ok(fingerprint) => println!("{}", fingerprint),
        Err(error) => {
            eprintln!("{}", error);
            std::process::exit(1);
        }
    }
}
