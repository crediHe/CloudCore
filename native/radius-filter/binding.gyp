{
  "targets": [
    {
      "target_name": "radius_filter",
      "sources": ["src/radius_filter.cc", "src/addon.cc"],
      "include_dirs": [
        "../../node_modules/node-addon-api"
      ],
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
