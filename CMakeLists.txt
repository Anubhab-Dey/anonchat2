cmake_minimum_required(VERSION 3.25)

project(anonchat LANGUAGES C)

set(CMAKE_C_STANDARD 23)
set(CMAKE_C_STANDARD_REQUIRED ON)

add_executable(anonchat
    src/server.c
)

target_compile_options(anonchat PRIVATE
    -Wall
    -Wextra
    -pedantic
)

target_compile_definitions(anonchat PRIVATE
    ANONCHAT_WEB_DIR="${CMAKE_CURRENT_SOURCE_DIR}/web"
)

target_link_libraries(anonchat PRIVATE
    websockets
    bcrypt
    sqlite3
)
