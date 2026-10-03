{
  "targets": [
    {
      "target_name": "normal_estimate",
      "sources": ["src/normal_estimate.cc", "src/normal_compressor.cc", "src/addon.cc"],
      "include_dirs": ["../../node_modules/node-addon-api"],
      "conditions": [
        ["OS==\"win\"", {
          "msvs_settings": {
            "VCCLCompilerTool": {
              "AdditionalOptions": ["/std:c++17", "/O2", "/EHsc", "/utf-8"]
            }
          }
        }],
        ["OS!=\"win\"", {
          "cflags_cc": ["-std=c++17", "-O3"]
        }]
      ]
    }
  ]
}
